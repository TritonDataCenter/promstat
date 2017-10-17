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
var mod_extsprintf = require('extsprintf');
var mod_events = require('events');
var mod_jsprim = require('jsprim');
var mod_vasync = require('vasync');
var mod_util = require('util');
var VError = require('verror');

var lib_si = require('./setinterval');
var lib_prometheus = require('./prometheus');

var sprintf = mod_extsprintf.sprintf;

exports.PromConsumer = PromConsumer;
exports.Promstat = Promstat;
exports.promListMetrics = promListMetrics;
exports.promPrintDistribution = promPrintDistribution;

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
 * Mutable structure representing the Promstat state for a particular metric.
 * This includes a link to the metadata as well as recently-observed values.
 */
function PromstatMetricData(args)
{
	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.name, 'args.name');

	/* metric name (unique identifier) */
	this.pm_name = args.name;

	/* PromMetricMetadata for this metric (only once we've retrieved it) */
	this.pm_metadata = null;

	/*
	 * We record two sets of values for each target:
	 *
	 * - the "last" value seen, which is more precisely the value returned
	 *   by the last fetch operation.  On success, this is usually a numeric
	 *   value.  If this target did not report this metric at all, this will
	 *   be "null".  If we could not parse the result (e.g., because it was
	 *   an unsupported type), the value here could be an instance of Error.
	 *
	 * - the "previous" _valid_ value seen.  This is the last valid
	 *   datapoint observed before "last".  This is really only needed for
	 *   counters so that we can compute deltas, but we track this for all
	 *   metrics.
	 */
	this.pm_last_valsbytgt = {};
	this.pm_prev_valsbytgt = {};
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
		var parsed;

		mod_assertplus.ok(results,
		    'fetchAllMetrics returned no results');
		parsed = promMetadataParse(err, results);
		callback(VError.errorFromList(parsed.warnings),
		    { 'metrics': parsed.metrics });
	});
}

function promMetadataParse(warning_err, results)
{
	var metrics, metbyname, warnings;

	metrics = [];
	metbyname = {};
	warnings = [];

	if (warning_err) {
		VError.errorForEach(warning_err, function iterError(e) {
			warnings.push(e);
		});
	}

	results.eachTarget(function iterTargets(target, tgtmetrics) {
		mod_jsprim.forEachKey(tgtmetrics,
		    function iterTargetMetrics(name, metinfo) {
			var met;

			mod_assertplus.string(name, 'name');
			mod_assertplus.object(metinfo, 'metinfo');
			mod_assertplus.string(metinfo.help, 'metinfo.help');
			mod_assertplus.string(metinfo.type, 'metinfo.type');

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
					    target.pt_label, metinfo.type,
					    met.pmm_target, met.pmm_type));
				}

				if (metinfo.help != met.pmm_help) {
					warnings.push(new VError(
					    'metric "%s": target ' +
					    '"%s" reported different ' +
					    'help text than target ' +
					    '"%s"', name, target.pt_label,
					    met.pmm_target));
				}
			}
		    });
	});

	return ({
	    'warnings': warnings,
	    'metrics': metrics,
	    'metricsByName': metbyname
	});
}


/*
 * The Promstat class encapsulates a consumer's request to monitor a specific
 * group of metrics from a specific set of targets on a regular basis.
 * Consumers first create a PromConsumer, which is used to specify the targets.
 * Then they create a Promstat instance and specify specific metrics.  The
 * Promstat instance keeps track of:
 *
 *    - the consumer (which specifies the targets)
 *    - the metrics that the caller is interested in
 *    - the interval between request attempts
 *    - other parameters (e.g., timeouts, concurrency limits)
 *    - metadata for each metric
 *    - the last value received from each target for each metric
 *
 * TODO when we decide to add built-in aggregation (e.g., summarize stats from
 * all targets), we should use node-skinner, and that should drop in here.
 *
 * After creating a Promstat instance, consumers invoke start() to start polling
 * for data.  Once per interval, the poller fetches the count for each metric.
 * When it has finished this (because every target has either responded or timed
 * out), it emits a 'tick' event.  This event includes a 'metrics' argument of
 * class "PromstatMetricsData" from which the consumer can extract values for
 * each metric.
 *
 * Named arguments:
 *
 *     consumer		see PromConsumer().
 *
 *     concurrency	concurrency with which to fetch metrics from targets.
 *     			In most cases, consumers want to present a group of
 *     			metrics associated with a single timestamp.  To be
 *     			accurate, that requires all of the metrics to be
 *     			collected about the same time, so you probably want
 *     			"concurrency" set at least as high as the number of
 *     			targets.  However, if you're scraping a very large
 *     			number of targets and you don't care so much about
 *     			timestamp precision, limited concurrency might be a
 *     			better option.
 *
 *     requestTimeout   timeout associated with each request to a target, in
 *     			milliseconds.  Note that the behavior when this timeout
 *     			exceeds the requested interval is unspecified.  This
 *     			implementation does not allow intervals to overlap, so
 *     			if the timeout is longer than the interval, and if a
 *     			target routinely times out, you'll get data points as
 *     			far apart as the request timeout, not the interval.
 *     			Future implementations could change the way this works.
 *     			Ultimately, it's not clear what the desired behavior
 *     			should be if a server is routinely taking longer than
 *     			the requested interval to provide a response.
 *
 *     interval		time between fetch operations, in milliseconds.  This
 *     			implementation attempts to start fetch operations every
 *     			"interval" milliseconds, even if the operation takes
 *     			half of that interval.  (That is, if the interval is 1s,
 *     			and the operation takes 500ms, it will wait for only
 *     			500ms before trying again in order to try to have
 *     			per-second data.)
 *
 *     niterations	number of iterations to complete before stopping.  If
 *     (optional)	unspecified, fetching metrics continues indefinitely.
 */
function Promstat(args)
{
	var self = this;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.consumer, 'args.consumer');
	mod_assertplus.number(args.concurrency, 'args.concurrency');
	mod_assertplus.number(args.interval, 'args.interval');
	mod_assertplus.number(args.requestTimeout, 'args.requestTimeout');
	mod_assertplus.optionalNumber(args.niterations, 'args.niterations');

	/* immutable arguments */
	this.ps_consumer = args.consumer;
	this.ps_concurrency = args.concurrency;
	this.ps_intervalms = args.interval;
	this.ps_rqtimeout = args.requestTimeout;
	this.ps_max_iters = typeof (args.niterations) == 'number' ?
	    args.niterations : null;

	/* interval timer handle */
	this.ps_ihdl = null;
	this.ps_niters = 0;
	this.ps_tick = function onPromstatTick() {
		self.tick();
	};

	/* state about the current fetch operation */
	this.ps_fetch_running = false;		/* currently fetching */
	this.ps_nskipped = 0;			/* skipped while busy */
	/* for debugging only */
	this.ps_fetch_last_start = null;	/* last start time */
	this.ps_fetch_last_done = null;		/* last finish time */

	/*
	 * Consumers request specific metrics using addMetric() below.
	 * ps_metrics_requested describes these metrics, including their names
	 * and any alias that the consumer has provided.  In the future, this
	 * could also describe instructions for node-krill-based filtering and
	 * node-skinner-based aggregation.
	 */
	this.ps_metrics_requested = [];

	mod_events.EventEmitter.call(this);
}

mod_util.inherits(Promstat, mod_events.EventEmitter);

Promstat.prototype.start = function promstatStart()
{
	mod_assertplus.strictEqual(this.ps_ihdl, null,
	    'cannot call start() more than once');
	this.ps_ihdl = lib_si.setIntervalPrecise(
	    this.ps_tick, this.ps_intervalms);
	this.ps_tick();
};

/*
 * Requests that this promstat instance track values for the specified metric.
 * This currently only supports bare counters and gauges, but future versions
 * could support filtering or aggregating in different ways.
 *
 * Named arguments:
 *
 *     name		raw metric name, as exported by targets
 */
Promstat.prototype.addMetric = function (metricconf)
{
	mod_assertplus.object(metricconf, 'metricconf');
	mod_assertplus.string(metricconf.name, 'metricconf.name');

	this.ps_metrics_requested.push(new PromstatMetricData({
	    'name': metricconf.name
	}));
};

Promstat.prototype.tick = function promstatTick()
{
	var self = this;

	if (this.ps_fetch_running) {
		this.ps_nskipped++;
		return;
	}

	this.ps_fetch_running = true;
	this.ps_fetch_last_start = new Date();

	/*
	 * If we're about to collect the last data point, clear the interval
	 * timer so that we don't tick again.  (For most command-line consumers,
	 * this will allow the program to exit once we've finished with the last
	 * data point.)
	 */
	this.ps_niters++;
	if (this.ps_max_iters !== null &&
	    this.ps_niters == this.ps_max_iters) {
		lib_si.clearIntervalPrecise(this.ps_ihdl);
	}
	mod_assertplus.ok(this.ps_max_iters === null ||
	    this.ps_niters <= this.ps_max_iters);

	this.ps_consumer.fetchAllMetrics({
	    'concurrency': this.ps_concurrency,
	    'requestTimeout': this.ps_rqtimeout
	}, function (err, results) {
		mod_assertplus.ok(results,
		    'fetchAllMetrics returned no results');
		self.consumeMetricResults(results);
		self.ps_fetch_last_done = new Date();
		self.ps_fetch_running = false;
		self.emitDatapoint(err);
	});
};

Promstat.prototype.consumeMetricResults = function promstatConsume(results)
{
	var parsed, warnings, metbyname, valsbymetname;
	var self = this;

	parsed = promMetadataParse(null, results);
	warnings = parsed.warnings;
	metbyname = parsed.metricsByName;

	/*
	 * The fetch process organizes results by target, but it's easier to
	 * work by metric here.  XXX should we change one of these interfaces?
	 */
	valsbymetname = {};
	results.eachTarget(function iterTargets(target, tgtmetrics) {
		mod_jsprim.forEachKey(tgtmetrics, function (name, metinfo) {
			if (!mod_jsprim.hasKey(valsbymetname, name)) {
				valsbymetname[name] = {};
			}

			mod_assertplus.string(target.pt_id);
			if (!valsbymetname[name][target.pt_id]) {
				valsbymetname[name][target.pt_id] = [];
			}

			valsbymetname[name][target.pt_id].push({
			    'target': target,
			    'labelKey': metinfo.labelKey,
			    'datapoints': metinfo.datapoints
			});
		});
	});

	/*
	 * Iterate the metrics requested by the consumer and fill in any
	 * metadata and values that we've found as part of this scrape.
	 */
	this.ps_metrics_requested.forEach(function (metric) {
		if (metric.pm_metadata === null) {
			if (!mod_jsprim.hasKey(metbyname, metric.pm_name)) {
				/*
				 * We had no metadata, and this scrape did not
				 * find any.  At this point, no target has ever
				 * mentioned this metric.  There's nothing else
				 * to do for this metric right now.
				 */
				return;
			}

			/*
			 * We've received this metric's metadata for the first
			 * time.  Record it here.
			 */
			metric.pm_metadata = metbyname[metric.pm_name];
		} else if (mod_jsprim.hasKey(metbyname, metric.pm_name) &&
		    metbyname[metric.pm_name].pmm_type !=
		    metric.pm_metadata.pmm_type) {
			/*
			 * In this case, we received metadata that changes the
			 * type of this metric.  We could conceivably handle
			 * this by throwing out the value we have and starting
			 * afresh, but given how strange this seems, we just
			 * emit a warning and skip this metric.
			 *
			 * Note that because we don't process targets' results
			 * in a deterministic order, if one target reports a
			 * different type from another, the metric might seem to
			 * flap between types.  That's not great, but again,
			 * this case seems weird enough that we need operational
			 * experience before figuring out how we want this tool
			 * to handle it.
			 */
			warnings.push(new VError('metric "%s": type seems ' +
			    'to have changed (was %s, now %s)', metric.pm_name,
			    metric.pm_metadata.pmm_type,
			    metbyname[metric.pm_name].pmm_type));
			return;
		}

		/*
		 * With the odd cases out of the way, let's incorporate these
		 * data points.
		 */
		self.ps_consumer.pc_targets.forEach(function (tgt) {
			var v;

			mod_assertplus.string(tgt.pt_id);
			if (mod_jsprim.hasKey(valsbymetname, metric.pm_name) &&
			    mod_jsprim.hasKey(valsbymetname[metric.pm_name],
			    tgt.pt_id)) {
				v = [];
				valsbymetname[metric.pm_name][
				    tgt.pt_id].forEach(function (elt) {
					v = v.concat(elt['datapoints']);
				    });
			} else {
				v = null;
			}

			consumeValue({
			    'metric': metric,
			    'targetId': tgt.pt_id,
			    'datapoints': v
			});
		});
	});
};

Promstat.prototype.emitDatapoint = function (warning_err)
{
	var datapoint;
	var self = this;

	datapoint = {};
	datapoint.psd_warnings = [];
	datapoint.psd_start = this.ps_fetch_last_start;
	datapoint.psd_done = this.ps_fetch_last_done;
	datapoint.psd_tgtvalues = {};

	if (warning_err) {
		VError.errorForEach(warning_err, function (e) {
			datapoint.psd_warnings.push(warning_err);
		});
	}

	this.ps_consumer.pc_targets.forEach(function (tgt) {
		var tgtvalues, tid;

		tid = tgt.pt_id;
		datapoint.psd_tgtvalues[tid] = {
		    'target': tgt,
		    'values': []
		};
		tgtvalues = datapoint.psd_tgtvalues[tid]['values'];
		self.ps_metrics_requested.forEach(function (metric) {
			var metadata, type, value;
			var c, p, deltas, todo;

			metadata = metric.pm_metadata;
			if (metadata === null) {
				tgtvalues.push({
				    'metadata': null,
				    'latestRaw': new Error('no data')
				});
				return;
			}

			type = metadata.pmm_type;
			value = {};
			tgtvalues.push(value);
			value['metadata'] = metric.pm_metadata;

			if (!mod_jsprim.hasKey(metric.pm_last_valsbytgt, tid) ||
			    metric.pm_last_valsbytgt[tid] === null) {
				value['latestRaw'] = null;
				return;
			}

			value['latestRaw'] = metric.pm_last_valsbytgt[tid];
			if (value['latestRaw'] instanceof Error) {
				return;
			}

			if (type == 'gauge') {
				return;
			}

			if (!mod_jsprim.hasKey(metric.pm_prev_valsbytgt, tid)) {
				return;
			}

			value['prevRaw'] = metric.pm_prev_valsbytgt[tid];
			if (type == 'counter') {
				value['latestDelta'] = value['latestRaw'] -
				    value['prevRaw'];
				return;
			}

			if (type != 'histogram') {
				value['latestRaw'] = new Error(
				    'unsupported type');
				return;
			}

			c = value['latestRaw'];
			p = value['prevRaw'];
			mod_assertplus.object(c);
			mod_assertplus.object(p);

			/*
			 * The old and new value should have exactly the same
			 * set of keys.  (TODO If not, we should handle this
			 * more gracefully.)
			 */
			todo = {};
			deltas = {};
			mod_jsprim.forEachKey(c, function (bound, v) {
				todo[bound] = true;
				deltas[bound] = v;
			});

			mod_jsprim.forEachKey(p, function (bound, v) {
				if (!mod_jsprim.hasKey(todo, bound)) {
					value['latestRaw'] = new Error(
					    'histogram fields changed');
				}

				delete (todo[bound]);
				deltas[bound] -= v;
			});

			if (value['latestRaw'] instanceof Error ||
			    !mod_jsprim.isEmpty(todo)) {
				value['latestRaw'] = new Error(
				     'histogram fields changed');
				return;
			}

			value['latestDelta'] = deltas;
		});
	});

	this.emit('tick', datapoint);
};

function consumeValue(args)
{
	var tid, metric, value;
	var hist;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.metric, 'args.metric');
	mod_assertplus.string(args.targetId, 'args.targetId');
	mod_assertplus.optionalArrayOfObject(args.datapoints,
	    'args.datapoints');

	tid = args.targetId;
	metric = args.metric;

	/*
	 * We keep track of the last value observed for each metric, which could
	 * be null (if there was no data from the last scrape) or an error (if
	 * we could not understand the value we got, as because it had an
	 * unsupported type).
	 *
	 * We also keep track of the previous _valid_ value observed for each
	 * metric.  This is the value previous to the last value, and we only
	 * keep track of values where we had a data point and there was no
	 * error.  This is currently only used for counters to compute the delta
	 * from the last observed value, but it's easy enough to keep for
	 * everything so we just do that in case we need to debug it.
	 *
	 * Here, if our last observed value was valid, we advance it to
	 * "previous".  The rest of this function updates the "last" value
	 * recorded with the value we just read.
	 */
	if (mod_jsprim.hasKey(metric.pm_last_valsbytgt, tid) &&
	    metric.pm_last_valsbytgt[tid] !== null &&
	    !(metric.pm_last_valsbytgt[tid] instanceof Error)) {
		metric.pm_prev_valsbytgt[tid] = metric.pm_last_valsbytgt[tid];
	}

	/*
	 * If we have no data for a particular data point, we'll record that
	 * here so that we can present that to the consumer.  There's nothing
	 * else to do.
	 */
	if (args.datapoints === undefined || args.datapoints === null) {
		metric.pm_last_valsbytgt[tid] = null;
		return;
	}

	if (metric.pm_metadata.pmm_type == 'counter' ||
	    metric.pm_metadata.pmm_type == 'gauge') {
		/*
		 * Currently, we aggregate values from all fields.  For
		 * counters, that's easy: just add them up.  For gauges, it's
		 * hard to know what's best, but adding them works for the cases
		 * we have today, so that's what we do.
		 */
		value = 0;
		args.datapoints.forEach(function (v) {
			value += v.value;
		});

		metric.pm_last_valsbytgt[tid] = value;
		return;
	}

	if (metric.pm_metadata.pmm_type != 'histogram') {
		metric.pm_last_valsbytgt[tid] = new Error('unsupported type');
		return;
	}

	hist = {};
	args.datapoints.forEach(function (dp) {
		mod_assertplus.equal('number', typeof (dp.fields['le']));
		if (!hist.hasOwnProperty(dp.fields['le'])) {
			hist[dp.fields['le']] = 0;
		}

		hist[dp.fields['le']] += dp.value;
	});

	metric.pm_last_valsbytgt[tid] = hist;
}

/*
 * This function takes a distribution provided by Prometheus (in the form
 * provided by our Prometheus metric parser) and returns a string that prints
 * out the distribution similar to the way dtrace(1M) would.
 *
 * It's a programmer error to provide an object that does not match the form
 * produced by the Prometheus parser here.  Specifically, the "distribution"
 * argument should be an object with keys that are either numbers or the special
 * strings "Infinity" or "-Infinity".  (The infinity values differ from those
 * exported by Golang because we've already parsed Golang's string "+Inf" as the
 * JavaScript value Infinity and then serialized that as a string to stick it
 * into this object.) The values should be actual numbers.
 * TODO a crisper representation would be nice.
 *
 * This is closely related to the dnPrintDistribution() function in Dragnet,
 * which is itself modeled after dtrace's implementation.  It's not clear what
 * should be commonized between this and Dragnet.
 *
 * Note that in DTrace output, the row with key "N" displays the values with a
 * key at least "N" and less than the value in the next row.  Thus, "N" is the
 * smallest key in the bucket.  (The last row always has a key larger than all
 * previous keys and a value of 0, indicating that the previous row represents
 * the largest values.)  By contrast, Prometheus organizes data so that the key
 * represents the largest key in the bucket.
 * XXX Is it cleaner to differ from the DTrace output in this way?  As it is,
 * this is going to be confusing for values that exactly match the bucket
 * boundary, and the only way to deal with that (and preserve the DTrace output
 * semantics) is to assume that these are integers.
 */
function promPrintDistribution(args)
{
	var dist, keys, posinf, neginf;
	var ki, ddist, di, bound, count, i;
	var total, normalized, dots, rv;

	mod_assertplus.object(args, 'args');
	mod_assertplus.object(args.distribution, 'args.distribution');

	dist = args.distribution;
	posinf = false;
	neginf = false;
	keys = [];
	mod_jsprim.forEachKey(dist, function (b, value) {
		var v;

		mod_assertplus.number(value,
		    'value for bound "' + b + '" is not a number');
		if (b == Infinity.toString()) {
			posinf = true;
		} else if (b == -Infinity.toString()) {
			neginf = true;
		} else {
			v = parseFloat(b);
			mod_assertplus.ok(!isNaN(v),
			    'bound "' + b + '" not a float');
			keys.push(v);
		}
	});

	/*
	 * XXX is this validated elsewhere?
	 * XXX need to figure out what Prometheus histograms with negative keys
	 * look like.  Do they have -Infinity?  (Why don't all of them have that
	 * value?)
	 */
	mod_assertplus.ok(posinf, 'missing Infinity value');
	mod_assertplus.ok(!neginf, 'did not expect -Infinity value');
	rv = '           ' +
	    'value  ------------- Distribution ------------- count\n';

	/*
	 * Construct a distribution that looks more like the DTrace distribution
	 * model, where we represent this with an array, we keep lower bounds
	 * for each bucket, and we keep only the value in each bucket (rather
	 * than a cumulative value).
	 *
	 * With Prometheus, the lowest bound we have is the upper bound of the
	 * largest bucket.  For the lower bound, we'll use -Infinity.
	 */
	keys = keys.sort(function (a, b) { return (a - b); });
	if (keys.length === 0) {
		return (rv);
	}

	ddist = [];
	ddist.push([ keys[0] < 0 ? -Infinity : 0, dist[keys[0]] ]);
	for (ki = 1; ki < keys.length; ki++) {
		ddist.push([ keys[ki - 1], dist[keys[ki]] ]);
	}

	ddist.push([ keys[keys.length - 1], dist[Infinity.toString()] ]);

	total = dist[Infinity.toString()];
	for (di = 0; di < ddist.length; di++) {
		bound = ddist[di][0].toString();
		count = ddist[di][1];
		if (di > 0) {
			count -= ddist[di - 1][1];
		}

		normalized = Math.round(40 * count / total);
		dots = '';
		for (i = 0; i < normalized; i++) {
			dots += '@';
		}
		for (; i < 40; i++) {
			dots += ' ';
		}

		rv += sprintf('%16s |%s %s\n', bound, dots, count);
	}

	return (rv);
}

/*
 * The PromstatMetricsData (XXX) class encapsulates the result of polling all
 * targets for one interval.  Interpreting metric data is a little tricky:
 * gauges and counters are both numbers, for example, but they're interpreted
 * very differently.  Besides that, counters are usually used to show deltas
 * over time.  If we scrape at time T1 and find a counter with value V1, and we
 * scrape again at T2 and find value V2, there are a couple of ways to present
 * this:
 *
 *     - We could provide the delta (V2 - V1) for a tool to report the raw
 *       change in values.  This may be appropriate for tools like prstat(1M)
 *       that report the delta for an entire interval when you give them an
 *       interval like 5 seconds.  But people usually want timestamps associated
 *       with data points, and the consumer might reasonably expect it coudl
 *       just print the timestamp when it got the data point.  But T2 isn't
 *       necessarily now, and T1 isn't necessarily the last time we collected
 *       data, particularly if there was a failed request in between.
 *     - We could provide the normalized, per-second delta.  Tools like
 *       mpstat(1M) and iostat(1M) report this by default.  This implicitly
 *       assumes that the counter changes are uniformly distributed over time
 *       (or at least that an average is a reasonable approximation of the
 *       change over time).  Besides being misleading, this can result in smooth
 *       data appearing to jump around a lot based on when it was sampled.
 *     - We could provide the delta (V2 - V1) and time delta (T2 - T1).  This
 *       would allow the consumer to do whatever it wants: it could normalize it
 *       if it wants, or it could show the delta in values.
 *     - We could provide the raw data: (T1, V1), (T2, V2).  This is the most
 *       flexible, but also requires consumers to do the real work in most
 *       cases.
 *
 * We opt for providing several of these for both flexibility and completeness.
 *
 * This is all much simpler for gauges, since they don't represent deltas.
 * They're just snapshots at a point in time.
 * XXX need to actually incorporate this into Promstat.emitDatapoint()
 */
