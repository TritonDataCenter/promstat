/*
 * promstat.js: general promstat facilities
 */

var mod_assertplus = require('assert-plus');
var mod_vasync = require('vasync');
var VError = require('verror');

var lib_prometheus = require('./prometheus');

exports.Promstat = Promstat;

var PROMSTAT_CONCURRENCY = 10;
var PROMSTAT_TIMEOUT = 5000;

function Promstat()
{
	this.psi_targets = [];
	this.psi_metrics = [];

	this.psi_queue = null;
	this.psi_callback = null;
	this.psi_results = null;
	this.psi_errors = null;
}

Promstat.prototype.addMetric = function (metric)
{
	mod_assertplus.string(metric, 'metric');
	this.psi_metrics.push(metric);
};

Promstat.prototype.addTarget = function (target)
{
	mod_assertplus.object(target, 'target');
	mod_assertplus.string(target.t_label, 'target.t_label');
	mod_assertplus.string(target.t_hostname, 'target.t_hostname');
	mod_assertplus.string(target.t_pathname, 'target.t_pathname');
	mod_assertplus.number(target.t_port, 'target.t_port');

	this.psi_targets.push({
	    't_id': this.psi_targets.length,
	    't_label': target.t_label,
	    't_hostname': target.t_hostname,
	    't_pathname': target.t_pathname,
	    't_port': target.t_port
	});
};

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
		var errors, results;

		errors = self.psi_errors;
		results = self.psi_results;
		mod_assertplus.equal(callback, self.psi_callback);

		self.psi_errors = null;
		self.psi_results = null;
		self.psi_callback = null;
		self.psi_queue = null;

		callback(VError.errorFromList(errors), results);
	});

	queue.close();
};

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
