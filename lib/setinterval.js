/*
 * setinterval.js: a more precise implementation of setInterval.
 *
 * The exported functions here are intended to have exactly the same semantics
 * as setInterval/clearInterval, except we believe this approach is more likely
 * to result in invoking the requested function at the specified period, instead
 * of having invocations _separated_ by the same period.
 */

var mod_assertplus = require('assert-plus');

exports.setIntervalPrecise = setIntervalPrecise;
exports.clearIntervalPrecise = clearIntervalPrecise;

function setIntervalPrecise(func, intervalms)
{
	var interval;

	mod_assertplus.func(func, 'func');
	mod_assertplus.number(intervalms, 'interval');
	mod_assertplus.ok(intervalms >= 0, 'interval >= 0');

	interval = {
	    'i_func': func,
	    'i_interval': intervalms,
	    'i_args': Array.prototype.slice.call(arguments, 2),
	    'i_id': null
	};

	interval.i_id = setTimeout(
	    siFireTimeout, interval.i_interval, interval);
	return (interval);
}

function siFireTimeout(interval)
{
	interval.i_id = setTimeout(
	    siFireTimeout, interval.i_interval, interval);
	interval.i_func.apply(null, interval.i_args);
}

function clearIntervalPrecise(interval)
{
	clearTimeout(interval.i_id);
	interval.i_id = null;
}
