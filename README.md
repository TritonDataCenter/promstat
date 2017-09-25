# promstat - command-line prometheus agent poller

promstat is a simple tool for fetching metrics from an endpoint that exposes the
[Prometheus text-based
format](https://prometheus.io/docs/instrumenting/exposition_formats/).

## TODO

- given a hostname target, expand to the list of all matching IPs
- add ability to rename metrics in output (similar to ps(1))
- add "-l" mode that just lists the metrics
- add support for filter or breakdown by field using krill (+ skinner?)
