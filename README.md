# promstat - command-line prometheus agent poller

promstat is a simple tool for fetching metrics from an endpoint that exposes the
[Prometheus text-based
format](https://prometheus.io/docs/instrumenting/exposition_formats/).

## TODO

- add "-l" mode that just lists the metrics
- when asking for unknown metrics, print "no data" instead of nothing
- lib/promstat.js could use a lot of cleanup
- initial data point should probably show time "-" or "all time" or something
- figure out if counters should be normalized to the sample interval or not
  (and implement that)
- given a hostname target, expand to the list of all matching IPs
- add ability to rename metrics in output (similar to ps(1))
- add support for filter or breakdown by field using krill (+ skinner?)
  In the limit, it would be nice if this looked like DTrace aggregation output,
  and timestamp and target could just be two prepopulated fields.
