/*
 * promstat.js: general promstat facilities
 */

var mod_assertplus = require('assert-plus');
var mod_jsprim = require('jsprim');
var mod_vasync = require('vasync');
var VError = require('verror');

var lib_prometheus = require('./prometheus');

exports.Promstat = Promstat;

var PROMSTAT_CONCURRENCY = 10;
var PROMSTAT_TIMEOUT = 5000;

function Promstat()
{
	/* List of targets (objects). */
	this.psi_targets = [];
	/* Set of metrics requested (objects indexed by metric name) */
	this.psi_metrics = [];
	/* List of metric names requested (strings). */
	this.psi_metric_names = [];

	/* These fields are used to manage a single consume() operation. */
	this.psi_queue = null;
	this.psi_callback = null;
	this.psi_results = null;
	this.psi_errors = null;
}

Promstat.prototype.addMetric = function (metric)
{
	mod_assertplus.string(metric, 'metric');
	this.psi_metric_names.push(metric);

	/*
	 * A given metric name may be requested more than once.  This can be
	 * useful in testing.
	 */
	if (!mod_jsprim.hasKey(this.psi_metrics, metric)) {
		/* XXX Create a real class for this. */
		this.psi_metrics[metric] = {
		    'm_name': metric,	/* metric name */
		    'm_help': null,	/* help text */
		    'm_type': null,	/* reported type */
		    'm_warning': false,	/* warning about inconsistent meta */
		    'm_values': {}	/* last-known value for each target */
		};
	}
};

Promstat.prototype.addTarget = function (target)
{
	mod_assertplus.object(target, 'target');
	mod_assertplus.string(target.t_label, 'target.t_label');
	mod_assertplus.string(target.t_hostname, 'target.t_hostname');
	mod_assertplus.string(target.t_pathname, 'target.t_pathname');
	mod_assertplus.number(target.t_port, 'target.t_port');

	/* XXX Create a real class for this. */
	this.psi_targets.push({
	    't_id': this.psi_targets.length,
	    't_label': target.t_label,
	    't_hostname': target.t_hostname,
	    't_pathname': target.t_pathname,
	    't_port': target.t_port
	});
};

/*
 * Fetch a new set of data points from every target.  Invokes "callback(err)"
 * upon completion.
 */
Promstat.prototype.consume = function (callback)
{
	var queue, i;
	var self = this;

	mod_assertplus.strictEqual(this.psi_queue, null,
	    'previous consume() is still running');
	mod_assertplus.strictEqual(this.psi_callback, null);
	mod_assertplus.strictEqual(this.psi_results, null);

	this.psi_callback = callback;
	this.psi_results = {};
	this.psi_errors = [];
	this.psi_queue = queue = mod_vasync.queuev({
	    'concurrency': PROMSTAT_CONCURRENCY,
	    'worker': function psWork(input, qcallback) {
		self.targetWork(input, qcallback);
	    }
	});

	for (i = 0; i < this.psi_targets.length; i++) {
		queue.push(this.psi_targets[i]);
	}

	queue.on('end', function consumeDone() {
		var errors;

		errors = self.psi_errors;
		mod_assertplus.equal(callback, self.psi_callback);

		self.update();

		self.psi_errors = null;
		self.psi_results = null;
		self.psi_callback = null;
		self.psi_queue = null;

		callback(VError.errorFromList(errors));
	});

	queue.close();
};

/*
 * Given a target, fetch the latest set of metric values from it.  Errors are
 * stored onto "self.psi_errors", not passed to the callback.
 */
Promstat.prototype.targetWork = function (target, qcallback)
{
	var self = this;

	lib_prometheus.promFetchMetrics({
	    'hostname': target.t_hostname,
	    'port': target.t_port,
	    'pathname': target.t_pathname,
	    'timeout': PROMSTAT_TIMEOUT
	}, function onFetchDone(err, metrics) {
		if (err) {
			self.psi_errors.push(err);
			qcallback();
			return;
		}

		self.psi_results[target.t_id] = {
		    'target': target,
		    'metrics': metrics
		};

		qcallback();
	});
};

/*
 * Update the current value that we're storing for each metric for each target.
 */
Promstat.prototype.update = function ()
{
	var tid, mname, metric, targetmetrics, targetmetric, tgtvalue;

	for (tid in this.psi_results) {
		targetmetrics = this.psi_results[tid].metrics;
		for (mname in targetmetrics) {
			targetmetric = targetmetrics[mname];
			if (!mod_jsprim.hasKey(this.psi_metrics, mname)) {
				continue;
			}

			metric = this.psi_metrics[mname];

			/*
			 * Set the metadata for the help text and type if we
			 * haven't done that already.  If the metadata is not
			 * consistent with what we have already, note that.
			 */
			if (metric.m_help === null) {
				metric.m_help = targetmetric.help;
			} else if (metric.m_help != targetmetric.help) {
				metric.m_warning = true;
			}

			if (metric.m_type === null) {
				metric.m_type = targetmetric.type;
			} else if (metric.m_type != targetmetric.type) {
				metric.m_warning = true;
				/*
				 * Skip this target's value, since it has the
				 * wrong type.
				 */
				continue;
			}

			switch (metric.m_type) {
			case 'counter':
				tgtvalue = 0;
				mod_jsprim.forEachKey(
				    targetmetric.valuesByFields,
				    function (f, v) {
					tgtvalue += v;
				    });

				if (!mod_jsprim.hasKey(
				    metric.m_values, tid)) {
					metric.m_values[tid] = {
					    'last': tgtvalue,
					    'current': tgtvalue
					};
				} else {
					metric.m_values[tid].current =
					    tgtvalue -
					    metric.m_values[tid].last;
					metric.m_values[tid].last = tgtvalue;
				}
				break;

			case 'gauge':
				tgtvalue = 'no data';
				/* XXX */
				mod_jsprim.forEachKey(
				    targetmetric.valuesByFields,
				    function (f, v) {
					tgtvalue = v;
				    });
				metric.m_values[tid] = { 'current': tgtvalue };

			default:
				/* XXX what do we do here? */
				tgtvalue = 'unsupported metric type';
				metric.m_values[tid] = { 'current': tgtvalue };
				break;
			}
		}
	}
};

Promstat.prototype.allValues = function ()
{
	var self = this;
	var rv = {};

	self.psi_targets.forEach(function (target) {
		rv[target.t_id] = {
		    'target': target,
		    'metrics': []
		};

		mod_jsprim.forEachKey(self.psi_metrics, function (_, metric) {
			if (metric.m_type === null) {
				return;
			}

			rv[target.t_id].metrics.push({
			    'm_name': metric.m_name,
			    'm_help': metric.m_help,
			    'm_type': metric.m_type,
			    'm_warning': metric.m_warning,
			    'm_value': mod_jsprim.hasKey(
			        metric.m_values, '' + target.t_id) ?
			        metric.m_values[target.t_id].current : 'no data'
			});
		});
	});

	return (rv);
};
