/*
 * promstat.js: general promstat facilities
 *
 * There are a few low-level facilities here:
 *
 *     - PromConsumer: This is the lowest-level interface, typically
 *       instantiated once per program.  This allows the consumer to specify one
 *       or more targets to scrape and provides a single method to scrape all of
 *       the targets.
 *
 *     - promListMetrics(): function that's given a PromConsumer, scrapes the
 *       targets, and summarizes the set of metrics provided by the specified
 *       targets.
 *
 *     - Promstat: This is a higher-level interface where consumers specify
 *       typical parameters for a stat reporting program, including the set of
 *       metrics the consumer is interested in and how they want them
 *       aggregated.  The object emits events when new data points arrive.
 *
 * These facilities allow consumers to easily list the metrics supported by any
 * number of Prometheus servers or report various metrics on a repeated basis.
 */

var mod_assertplus = require('assert-plus');
var mod_jsprim = require('jsprim');
var mod_vasync = require('vasync');
var VError = require('verror');

var lib_prometheus = require('./prometheus');

exports.PromConsumer = PromConsumer;
exports.Promstat = Promstat;
exports.promListMetrics = promListMetrics;

/* XXX remove */
var PROMSTAT_CONCURRENCY = 10;
var PROMSTAT_TIMEOUT = 5000;

/*
 * Immutable structure representing a single remote Prometheus HTTP exporter
 * endpoint.   This class is not directly exposed to consumers, but they may see
 * instances of it, and they're allowed to use the immutable fields defined
 * here.
 *
 * Named arguments:
 *
 *     id	unique identifier for this target.  In practice, this should be
 *     		unique within the PromConsumer.
 *
 *     label    human-readable label for this target
 *
 *     hostname DNS name or IP address to connect to.  It's strongly recommended
 *              that "hostname" represent an IP address.  When a user specifies
 *              a DNS name, it's likely we want to scrape all of the
 *              corresponding IPs, not just one.  The consumer should separately
 *              resolve the DNS name and create a target for each IP.
 *              XXX provide a function to do that and mention it here
 *
 *     port     TCP port on which to connext
 *
 *     pathname Path to request from the HTTP server
 */
function PromTarget(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.id, 'args.id');
	mod_assertplus.string(args.label, 'args.label');
	mod_assertplus.string(args.hostname, 'args.hostname');
	mod_assertplus.string(args.pathname, 'args.pathname');
	mod_assertplus.number(args.port, 'args.port');

	this.pt_id = args.id;
	this.pt_label = args.label;
	this.pt_hostname = args.hostname;
	this.pt_pathname = args.pathname;
	this.pt_port = args.port;
}

/*
 * Immutable structure representing metadata about a single Prometheus metric.
 * Like the PromTarget class, this is not directly exposed to consumers, but
 * they may see instances of it and they're allowed to use the immutable fields
 * defined here.
 */
function PromMetricMetadata(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.type, 'args.type');
	mod_assertplus.string(args.name, 'args.name');
	mod_assertplus.string(args.help, 'args.help');
	mod_assertplus.string(args.target, 'args.target');

	this.pmm_name = args.name;	/* metric's name (string, unique id) */
	this.pmm_type = args.type;	/* metric's type (string) */
	this.pmm_help = args.help;	/* metric's help text (string) */
	this.pmm_target = args.target;	/* label for the target where this */
					/* metadata came from */
	this.pmm_ntargets = 1;		/* count of targets providing */
					/* this metric */
}


/*
 * Externally-exported interface for constructing a list of target endpoints
 * (using addTarget()) and fetching the metrics from all of them.
 */
function PromConsumer()
{
	/* list of targets (objects) */
	this.pc_targets = [];
}

/*
 * See PromTarget() above.
 */
PromConsumer.prototype.addTarget = function (utargetargs)
{
	var targetargs, pt;

	/*
	 * Augment the caller-provided arguments with a unique identifier.
	 */
	mod_assertplus.strictEqual(utargetargs.id, undefined,
	    'caller is not allowed to specify target id');
	targetargs = Object.create(utargetargs);
	targetargs.id = this.pc_targets.length.toString();

	pt = new PromTarget(targetargs);
	this.pc_targets.push(pt);
};

/*
 * Fetches all metrics from all targets.  Named arguments:
 *
 *     concurrency	target concurrency for fetch requests
 *
 *     requestTimeout	maximum time to wait for any given target, in
 *     			milliseconds
 *
 * callback(err, result) is invoked upon completion with "err" (if there were
 * any errors) and "result".  "result" will always be present -- there can be
 * some results even if there were also some errors.
 *
 * To view the results, callers should use "result.eachTarget(func)".  "func"
 * will be invoked as "func(target, metrics)" for each target for which a
 * request was attempted.  Neither of the arguments should be modified.
 * "metrics" may be null if the request failed.
 *
 * There may be multiple of these operations going on concurrently for the same
 * consumer.  Each of these is tracked by the internal PromScrape class (defined
 * below).
 */
PromConsumer.prototype.fetchAllMetrics = function (args, callback)
{
	var ps;

	mod_assertplus.object(args, 'args');
	mod_assertplus.number(args.concurrency, 'args.concurrency');
	mod_assertplus.number(args.requestTimeout, 'args.requestTimeout');
	mod_assertplus.func(callback, 'callback');

	ps = new PromScrape({
	    'consumer': this,
	    'concurrency': args.concurrency,
	    'requestTimeout': args.requestTimeout,
	    'callback': callback
	});

	ps.start();
};


/*
 * PromScrape: tracks the state of a compound operation to fetch metrics from a
 * set of targets.  Named arguments:
 *
 *     consumer		PromConsumer instance, which specifies the targets
 *
 *     callback		Callback to invoke upon completion
 *
 *     concurrency	Concurrency with which to fetch metrics
 *
 *     requestTimeout	Maximum time to wait for any given request to complete,
 *     			in milliseconds If this timeout expires for a particular
 *     			request, the request will be aborted and an error will
 *     			be returned for that target.
 *
 * This constructor sets up data structures and values, but the caller should
 * invoke start() to actually start fetching metrics.
 */
function PromScrape(args)
{
	var self = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.consumer, 'args.consumer');
	mod_assertplus.func(args.callback, 'args.callback');
	mod_assertplus.number(args.concurrency, 'args.concurrency');
	mod_assertplus.number(args.requestTimeout, 'args.requestTimeout');

	/* arguments */
	this.psc_consumer = args.consumer;
	this.psc_callback = args.callback;
	this.psc_concurrency = args.concurrency;
	this.psc_rqtimeout = args.requestTimeout;

	/* scrape state */
	this.psc_errors = [];		/* list of errors encounted */
	this.psc_results = {};		/* set of results, by target id */
	this.psc_queue = mod_vasync.queuev({
	    'concurrency': this.psc_concurrency,
	    'worker': function promScrapeWorker(input, qcallback) {
		self.targetScrape(input, qcallback);
	    }
	});

	this.psc_queue.on('end', function promScrapeDone() {
		self.scrapeDone();
	});

	/* debugging information */
	this.psc_start = null;	/* time we started scraping */
	this.psc_done = null;	/* time we finished scraping */
}

/*
 * Start scraping the requested targets.  This must not be invoked more than
 * once.  (If you want to scrape multiple times, instantiate additional
 * PromScrape instances.)
 */
PromScrape.prototype.start = function ()
{
	var self = this;

	mod_assertplus.strictEqual(this.psc_start, null);
	this.psc_start = new Date();
	this.psc_consumer.pc_targets.forEach(function (t) {
		self.psc_queue.push(t);
	});

	self.psc_queue.close();
};

/*
 * Invoked by the vasync queue for each target that we intend to scrape.
 */
PromScrape.prototype.targetScrape = function (target, qcallback)
{
	var self = this;

	lib_prometheus.promFetchMetrics({
	    'hostname': target.pt_hostname,
	    'port': target.pt_port,
	    'pathname': target.pt_pathname,
	    'timeout': this.psc_rqtimeout
	}, function promScrapeTargetDone(err, metrics) {
		if (err) {
			self.psc_errors.push(err);
		} else {
			self.psc_results[target.pt_id] = metrics;
		}

		qcallback();
	});
};

/*
 * Invoked when the last target scrape has completed.
 */
PromScrape.prototype.scrapeDone = function ()
{
	mod_assertplus.notStrictEqual(this.psc_start, null);
	mod_assertplus.strictEqual(this.psc_done, null);
	this.psc_done = new Date();
	this.psc_callback(VError.errorFromList(this.psc_errors), this);
};

/*
 * Iterate the results of this scrape operation.  This is called by consumers
 * outside this subsystem.
 */
PromScrape.prototype.eachTarget = function (func)
{
	var self = this;

	mod_assertplus.func(func, 'func');

	/*
	 * We only claim to iterate the targets we tried to scrape.  It's
	 * possible that the target list in the consumer has changed since then,
	 * in which case we will iterate some extra targets here.
	 */
	this.psc_consumer.pc_targets.forEach(function (target) {
		mod_assertplus.string(target.pt_id);
		if (mod_jsprim.hasKey(self.psc_results, target.pt_id)) {
			func(target, self.psc_results[target.pt_id]);
		} else {
			func(target, null);
		}
	});
};


/*
 * Fetch metadata about the metrics supported by a set of remote endpoints.
 * Named arguments:
 *
 *     concurrency	target concurrency for fetch requests
 *
 *     requestTimeout	maximum time to wait for any given target, in
 *     			milliseconds
 *
 *     consumer		Prometheus consumer (specifies the targets)
 *
 * "callback" is invoked upon completion as "callback(err, metadata)".  As with
 * other interfaces here, it's possible for both "err" and "metadata" to be
 * present, in which case "err" represents non-fatal errors (i.e., warnings).
 * "metadata" is an object with properties:
 *
 *     metrics		array of PromMetricMetadata objects describing the
 *     			metrics found.
 *
 * Returns a handle that may be useful for debugging.
 */
function promListMetrics(args, callback)
{
	var pc;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.consumer, 'args.consumer');
	mod_assertplus.number(args.concurrency, 'args.concurrency');
	mod_assertplus.number(args.requestTimeout, 'args.requestTimeout');

	pc = args.consumer;
	pc.fetchAllMetrics({
	    'concurrency': args.concurrency,
	    'requestTimeout': args.requestTimeout
	}, function (err, results) {
		var metrics, metbyname, warnings;

		if (!results) {
			callback(err);
			return;
		}

		metrics = [];
		metbyname = {};
		warnings = [];

		if (err) {
			VError.errorForEach(err, function iterError(e) {
				warnings.push(e);
			});
		}

		results.eachTarget(function iterTargets(target, tgtmetrics) {
			mod_jsprim.forEachKey(tgtmetrics,
			    function iterTargetMetrics(name, metinfo) {
				var met;

				mod_assertplus.string(name, 'name');
				mod_assertplus.object(metinfo, 'metinfo');
				mod_assertplus.string(metinfo.help,
				    'metinfo.help');
				mod_assertplus.string(metinfo.type,
				    'metinfo.type');

				if (!mod_jsprim.hasKey(metbyname, name)) {
					met = new PromMetricMetadata({
					    'name': name,
					    'type': metinfo.type,
					    'help': metinfo.help,
					    'target': target.pt_label
					});
					metbyname[name] = met;
					metrics.push(met);
				} else {
					met = metbyname[name];
					met.pmm_ntargets++;

					if (metinfo.type != met.pmm_type) {
						warnings.push(new VError(
						    'metric "%s": target ' +
						    '"%s" reported type ' +
						    '"%s", but target "%s" ' +
						    'reported type "%s"', name,
						    target.pt_label,
						    metinfo.type,
						    met.pmm_target,
						    met.pmm_type));
					}

					if (metinfo.help != met.pmm_help) {
						warnings.push(new VError(
						    'metric "%s": target ' +
						    '"%s" reported different ' +
						    'help text than target ' +
						    '"%s"', name,
						    target.pt_label,
						    met.pmm_target));
					}
				}
			    });
		});

		callback(VError.errorFromList(warnings),
		    { 'metrics': metrics });
	});
}


function Promstat()
{
	/* List of targets (objects). */
	this.psi_targets = [];
	/* Set of metrics requested (objects indexed by metric name) */
	this.psi_metrics = {};
	/* List of metric names requested (strings). */
	this.psi_metric_names = [];
	/* Set of all metrics found (objects indexed by metric name) */
	/* XXX merge this with info in psi_metrics */
	this.psi_metrics_found = {};

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
			this.psi_metrics_found[mname] = {
			    'm_name': mname,
			    'm_type': targetmetric.type,
			    'm_help': targetmetric.help,
			    'm_warning': false /* XXX */
			};

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
				break;

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

Promstat.prototype.eachMetric = function (func)
{
	mod_jsprim.forEachKey(this.psi_metrics_found, function (_, metric) {
		if (metric.m_type !== null) {
			func(metric);
		}
	});
};
