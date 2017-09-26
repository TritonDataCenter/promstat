/*
 * promdemo.js: prometheus demo server
 */

var mod_artedi = require('artedi');
var mod_http = require('http');

var PORT = 8123;

var server, collector;
var counter, gauge;

function main()
{
	server = mod_http.createServer(handleRequest);
	server.listen(PORT, function () {
		console.error('server listening at ', server.address());
	});

	collector = mod_artedi.createCollector();
	counter = collector.counter({
	    'name': 'tenps',
	    'help': 'increments by about 10 per second',
	    'labels': {
	        'pid': process.pid
	    }
	});

	setInterval(function onCounterBump() {
		counter.increment();
	}, 90);

	gauge = collector.gauge({
	    'name': 'seventeen',
	    'help': 'gauge with value 17',
	    'labels': {
	        'pid': process.pid
	    }
	});

	gauge.add(17);
}

function handleRequest(request, response)
{
	if (request.url != '/metrics') {
		request.resume();
		response.writeHead(404);
		response.end();
		return;
	}

	if (request.method != 'GET') {
		request.resume();
		response.writeHead(405);
		response.end();
		return;
	}

	request.resume();
	request.on('end', function onRequestRead() {
		collector.collect(mod_artedi.FMT_PROM, function (err, metrics) {
			if (err) {
				response.writeHead(500);
				response.end(err.message);
			} else {
				response.writeHead(200);
				response.end(metrics);
			}
		});
	});
}

main();
