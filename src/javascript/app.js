var compression = require('compression')
var multer  = require('multer')
var express = require('express');
var path = require('path');
var logger = require('morgan');
var bodyParser = require('body-parser');
var http = require('http');
var https = require('https');

var datatable = require('./datatable');
var grid = require('./grid');
var rest_to_xmlrpc = require('./rest_to_xmlrpc');
var settings = require('./settings');
var composed_commands_routes = require('./typescript/app/routes');

http.globalAgent.maxSockets = 128;
https.globalAgent.maxSockets = 128;

var app = express();
app.use(compression());


app.all('*', function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'PUT, GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(bodyParser.urlencoded({
  extended: true
}));
app.use(bodyParser.json({limit: '5mb'}));

var router = rest_to_xmlrpc.router;

router.post('/datatable', datatable);
router.get('/datatable', datatable);

router.post('/grid', grid);
router.get('/grid', grid);


app.use('/composed_commands', composed_commands_routes.ComposedCommandsRoutes.routes());

app.use('/', router);

app.use(logger('dev'));

app.use(express.static(path.join(__dirname, 'public')));

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    res.status(err.status || 500).send({
      message: err.message,
      error: err
    });
  });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  res.status(err.status || 500).send({
    message: err.message,
    error: err
  });
});


module.exports = app;
