# promstat - command-line prometheus agent poller

promstat is a simple tool for fetching metrics from an endpoint that exposes the
[Prometheus text-based
format](https://prometheus.io/docs/instrumenting/exposition_formats/).

This is not a replacement for running a Prometheus server to collect and store
these metrics.  There's no plan for this tool to support storing data or running
queries on the data fetched.

## TODO

- when asking for unknown metrics, print "no data" instead of nothing
- lib/promstat.js could use a lot of cleanup
- figure out if counters should be normalized to the sample interval or not
  (and implement that)
  note: mpstat, iostat always normalize to per-second; prstat to per-interval.
- given a hostname target, expand to the list of all matching IPs
  - add option for breaking out by-target vs not
- add ability to rename metrics in output (similar to ps(1))
- add support for filter or breakdown by field using krill (+ skinner?)
  In the limit, it would be nice if this looked like DTrace aggregation output,
  and timestamp and target could just be two prepopulated fields.
- add tests
  - invalid CLI arguments
  - prometheus format parsing
  - bad endpoint
- make this a library interface so that it's easy for us to build moraystat,
  muskiestat?
