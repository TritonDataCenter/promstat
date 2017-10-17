/*
 * prometheus.js: Prometheus-specific utilities
 */

var mod_assertplus = require('assert-plus');
var mod_http = require('http');
var mod_jsprim = require('jsprim');
var mod_lstream = require('lstream');
var mod_stream = require('stream');
var mod_strsplit = require('strsplit');
var mod_util = require('util');
var mod_vstream = require('vstream');
var VError = require('verror');

exports.promFetchMetrics = promFetchMetrics;

/*
 * These regular expressions come directly from the Prometheus data model
 * documentation.  Parts of the parser below implicitly rely on these not
 * changing (i.e., that quotation marks, commas, and equals signs aren't allowed
 * in these tokens).
 */
exports.PROM_REGEXP_METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
exports.PROM_REGEXP_LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/*
 * Fetch metrics from a Prometheus endpoint.  Named arguments:
 *
 *   hostname		DNS name or IP address of the endpoint
 *
 *   port		TCP port of the endpoint
 *
 *   pathname		Path part of the URL where the server reports metrics.
 *   			(e.g., "/metrics")
 *
 *   timeout		Milliseconds after which to abort the request and report
 *   			a failure.
 *
 * "callback(err, metrics)" is invoked upon completion.  If present, "metrics"
 * is an object where each property is the name of a metric reported by the
 * endpoint, and each value is an object with:
 *
 *    help		reported help text for this metric
 *
 *    type		reported type for this metric
 *
 *    datapoints	an array of node-skinner-format data points, one data
 *    			point for each combination of labels reported, and each
 *    			data point being an object with properties:
 *
 *    		fields  an object mapping label names to their values
 *
 *    		value   the integer value of the metric having these labels
 *
 * TODO: The implementation in this file makes a lot of assumptions that work
 * for the specific Prometheus agents it has been tested against, but are
 * decidedly not true in general.  These assumptions include that every metric
 * will have help text, a type, and some labels -- in that order.  (In the
 * protocol, help text and type can appear in different orders, and labels are
 * optional.  Help text and type may be optional too.)
 */
function promFetchMetrics(args, callback)
{
	var hostname, pathname, port, timeoutms;
	var request, tid;
	var called = false;

	mod_assertplus.object(args, 'args');
	mod_assertplus.string(args.hostname, 'args.hostname');
	mod_assertplus.string(args.pathname, 'args.pathname');
	mod_assertplus.number(args.port, 'args.port');
	mod_assertplus.number(args.timeout, 'args.timeout');

	hostname = args.hostname;
	pathname = args.pathname;
	port = args.port;
	timeoutms = args.timeout;

	request = mod_http.get({
	    'hostname': hostname,
	    'path': pathname,
	    'port': port
	});

	request.on('error', function onRequestError(err) {
		mod_assertplus.ok(!called);
		called = true;

		clearTimeout(tid);
		err = new VError(err, 'fetch http://%s:%d%s',
		    hostname, port, pathname);
		callback(err);
	});

	request.on('response', function (response) {
		var lstream, parser, collector;
		var error_body;

		/*
		 * XXX this is probably not correct.  If we timed out, we want
		 * to ignore this response (well, resume() it to read all the
		 * data), but we'll probably blow this assertion instead.
		 *
		 * It would probably be useful to have a separate helper
		 * function that makes an HTTP request, waits up to a requested
		 * timeout for the response, buffers non-200-level responses and
		 * packages up an error for them, and returns a stream for
		 * 200-level responses.
		 */
		mod_assertplus.ok(!called);
		called = true;
		clearTimeout(tid);

		if (response.statusCode < 300) {
			lstream = new mod_lstream();
			parser = new PrometheusParserStream();
			collector = new PrometheusCollector();

			response.pipe(lstream);
			lstream.pipe(parser);
			parser.pipe(collector);

			/*
			 * XXX pipe through warnings somehow
			 */
			collector.on('finish', function () {
				callback(null, collector.result());
			});
			return;
		}

		/*
		 * This is an error response.  Read the whole response and
		 * construct an error.
		 */
		error_body = '';
		response.on('data', function (chunk) {
			/* TODO we ought to limit the amount we'll buffer. */
			error_body += chunk.toString('utf8');
		});

		response.on('end', function () {
			callback(new VError('fetch http://%s:%d%s: ' +
			    'unexpected response code %d with body: %s',
			    hostname, port, pathname, response.statusCode,
			    JSON.stringify(error_body)));
		});
	});

	tid = setTimeout(function onRequestTimeout() {
		mod_assertplus.ok(!called);
		called = true;
		request.abort();
		callback(new VError(
		    'fetch http://%s:%d%s: timed out after %dms',
		    hostname, port, pathname, timeoutms));
	}, timeoutms);
}

/*
 * This parser stream reads lines of output from a Prometheus text endpoint and
 * emits one object for each distinct metric value found.  The object includes:
 *
 *     help      reported help text for this metric
 *
 *     type      reported type for this metric
 *
 *     metric    name of the metric
 *
 *     labelKey  distinct identifier for the set of labels
 *
 *     labelMap  mapping of label names to their values
 *
 *     value     integer value of this metric for these labels
 *
 * TODO This implementation only works for a subset of Prometheus exporters.
 * See notes above.  We may be able to fix many of the assumptions by having
 * this stream be even dumber and leaving interpretation to the Collector.
 */
function PrometheusParserStream()
{
	mod_stream.Transform.call(this, {
	    'highWaterMark': 16,
	    'objectMode': true
	});

	mod_vstream.wrapTransform(this, { 'name': 'prometheus parser' });

	/*
	 * These fields are used to keep track of the last metric name, help
	 * text, or type that we've seen.  When cur_metric == null, we've never
	 * seen a metric at all.  When cur_help or cur_type is null, we have not
	 * seen the help text or type for this metric yet.
	 */
	this.cur_metric = null;
	this.cur_help = null;
	this.cur_type = null;
}

mod_util.inherits(PrometheusParserStream, mod_stream.Transform);

PrometheusParserStream.prototype._transform = function (line, _, callback)
{
	var parts, left, right, namestr, labelstr, valuestr, value, labelmap;

	/*
	 * We will always process this line immediately.
	 */
	setImmediate(callback);

	line = line.trim(); /* XXX check spec? */
	if (line.length === 0) {
		return;
	}

	if (line.charAt(0) == '#') {
		parts = mod_strsplit.strsplit(line, ' ', 4);
		if (parts.length != 4) {
			this.vsWarn(new VError('garbled line'), 'ngarbled');
			return;
		}

		mod_assertplus.equal(parts[0], '#');
		if (parts[1] == 'HELP') {
			this.cur_metric = parts[2];
			this.cur_help = parts[3];
			this.cur_type = null;
		} else if (parts[1] == 'TYPE') {
			if (this.cur_metric === null ||
			    this.cur_type !== null) {
				this.vsWarn(new Error('unexpected TYPE'),
				    'nunexpected_type');
				return;
			}

			if (parts[2] != this.cur_metric) {
				this.vsWarn(new VError(
				    'wrong metric (expected "%s", found "%s")',
				    this.cur_metric, parts[2]),
				    'nunexpected_metric');
				return;
			}

			this.cur_type = parts[3];
		} else {
			this.vsWarn(new VError('unexpected comment'),
			    'nunexpected_comment');
			return;
		}

		return;
	}

	if (this.cur_metric === null || this.cur_help === null ||
	    this.cur_type === null) {
		this.vsWarn(new VError('unexpected metric'),
		    'unexpected_metric');
		return;
	}

	/*
	 * This should be a metric line.  We should already have seen the "HELP"
	 * and "TYPE" lines for this metric.
	 */
	left = line.indexOf('{');
	right = line.lastIndexOf('}');

	/* XXX does this do the right thing when there are no labels? */
	if (left == -1 || right == -1) {
		this.vsWarn(new VError('garbled metric line'),
		    'ngarbledmetric');
		return;
	}

	namestr = line.substr(0, left);
	valuestr = line.substr(right + 1).trim();
	labelstr = line.substr(left + 1, right - left - 1);

	if (namestr != this.cur_metric) {
		this.vsWarn(new VError('unexpected metric name ' +
		    '(expected %s, found %s)', this.cur_metric, namestr),
		    'nunexpected_name');
		return;
	}

	parts = mod_strsplit.strsplit(valuestr, ' ', 2);
	value = mod_jsprim.parseInteger(parts[0]);
	if (value instanceof Error) {
		this.vsWarn(new VError('bad value'), 'badvalue');
		return;
	}

	labelmap = parseLabels(this.cur_type, labelstr);
	if (labelmap instanceof Error) {
		this.vsWarn(new VError('bad label string'), 'badlabelstr');
		return;
	}

	this.push({
	    'help': this.cur_help,
	    'type': this.cur_type,
	    'metric': this.cur_metric,
	    'labelKey': labelstr,
	    'labelMap': labelmap,
	    'value': value
	});
};

function parseLabels(type, labelstr)
{
	var labelmap, cur, nxt;
	var labelname, labelvalue, v;

	mod_assertplus.string(type, 'type');
	mod_assertplus.string(labelstr, 'labelstr');

	/*
	 * This parser is rather a hack, although it should handle anything
	 * except label values that themselves contain escaped quotation marks.
	 */
	labelmap = {};
	cur = 0;
	while (cur < labelstr.length) {
		nxt = labelstr.indexOf('=', cur);
		if (nxt == -1) {
			return (new VError('parsing labels: ' +
			    'character %d: expected "="', cur));
		}

		labelname = labelstr.substr(cur, nxt - cur);
		cur = nxt + 1;
		if (cur >= labelstr.length || labelstr.charAt(cur) != '"') {
			return (new VError('parsing labels: character %d: ' +
			    'expected \'"\'', cur));
		}

		nxt = labelstr.indexOf('"', cur + 1);
		if (nxt == -1) {
			return (new VError('parsing labels: ' +
			    'character %d: unterminated string', cur));
		}

		labelvalue = labelstr.substr(cur + 1, nxt - 1 - cur);
		labelmap[labelname] = labelvalue;
		cur = nxt + 1;

		mod_assertplus.ok(cur <= labelstr.length);
		if (cur == labelstr.length) {
			break;
		}

		if (labelstr.charAt(cur) != ',') {
			return (new VError('parsing labels: ' +
			    'character %d: expected comma or end of string',
			    cur));
		}

		cur = cur + 1;
	}

	if (type == 'histogram' && mod_jsprim.hasKey(labelmap, 'le')) {
		/*
		 * Label values are allowed to use values supported by Go's
		 * strconv package, which includes special strings "NaN",
		 * "+Inf", and "-Inf".  (Indeed, histograms must specify
		 * "+Inf".)
		 */
		if (labelmap['le'] == '+Inf') {
			labelmap['le'] = Infinity;
		} else if (labelmap['le'] == '-Inf') {
			labelmap['le'] = -Infinity;
		} else if (labelmap['le'] == 'NaN') {
			labelmap['le'] = 'NaN';
		} else {
			/*
			 * It would be nice if there were a jsprim analog of
			 * parseInteger, but for floats.
			 */
			v = parseFloat(labelmap['le']);
			if (isNaN(v)) {
				return (new VError('parsing labels: value ' +
				    'for label "le" could not be parsed ' +
				    'as a number: "%s"', labelmap['le']));
			}

			labelmap['le'] = v;
		}
	}

	return (labelmap);
}

/*
 * Writable stream that receives objects emitted by the PrometheusParserStream
 * and stores the values seen for each metric.  This object maintains a data
 * strutcure indexed by metric name whose value is described in
 * promFetchMetrics() above.
 */
function PrometheusCollector()
{
	mod_stream.Writable.call(this, {
	    'highWaterMark': 16,
	    'objectMode': true
	});

	mod_vstream.wrapStream(this);

	this.pc_metrics = {};
}

mod_util.inherits(PrometheusCollector, mod_stream.Writable);

PrometheusCollector.prototype._write = function (c, _, callback)
{
	var metric;

	/*
	 * We will handle this immediately.
	 */
	setImmediate(callback);

	mod_assertplus.string(c.type, 'c.type');
	mod_assertplus.string(c.help, 'c.help');
	mod_assertplus.string(c.metric, 'c.metric');
	mod_assertplus.string(c.labelKey, 'c.labelKey');
	mod_assertplus.object(c.labelMap, 'c.labelMap');
	mod_assertplus.number(c.value, 'c.value');

	if (!mod_jsprim.hasKey(this.pc_metrics, c.metric)) {
		this.pc_metrics[c.metric] = {
		    'help': c.help,
		    'type': c.type,
		    'datapoints': []
		};
	}

	metric = this.pc_metrics[c.metric];
	metric.datapoints.push({
	    'fields': c.labelMap,
	    'value': c.value
	});
};

PrometheusCollector.prototype.result = function ()
{
	return (this.pc_metrics);
};
