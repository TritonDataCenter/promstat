# promstat - command-line prometheus agent poller

promstat is a simple tool for fetching metrics from an endpoint that exposes the
[Prometheus text-based
format](https://prometheus.io/docs/instrumenting/exposition_formats/).

This is not a replacement for running a Prometheus server to collect and store
these metrics.  There's no plan for this tool to support storing data or running
queries on the data fetched.

## TODO

- add support for histograms
- warn the user if the request timeout exceeds the interval?
- general cleanup
  - many of the internal object structures could use proper classes
  - some of these could be broken up into separate files
  - some of the inter-module interfaces could be cleaner
  - many functions could use better comments
- figure out if counters should be normalized to the sample interval or not
  (and implement that)
  - note: mpstat, iostat always normalize to per-second; prstat to per-interval.
  - we should probably provide options for both.  Currently, we print deltas
    over the interval.  To provide per-second deltas, we'd want to keep better
    track of the time we scraped each endpoint and provide that delta in the
    "datapoint" event.
- given a hostname target, expand to the list of all matching IPs
  - do we want to do this here, or do we want to have consumers do this?  It's
    not clear we can really do discovery for the intended consumers (moray,
    muskie) without consumer-specific semantics.
- add ability to rename metrics in output (similar to ps(1))
- add support for filter or breakdown by field using krill (+ skinner?)
  In the limit, it would be nice if this looked like DTrace aggregation output,
  and timestamp and target could just be two prepopulated fields.
- add tests
  - invalid CLI arguments
  - prometheus format parsing
  - bad endpoint
- make this a library interface so that it's easy for us to build moraystat,
  muskiestat
