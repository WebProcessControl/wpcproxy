/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Patrick Gansterer <paroga@paroga.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var WebSocketServer = require('websocket').server;
var cbor = require('cbor');
var http = require('http');
var static = require('node-static');

var reverseClient = null;
var reverseClientMethods = null;
var pendingRequests = {};
var reverseSubscriptions = {};
var nextRequestId = 0;


function sendInternal(connection, messageId, requestId, payload) {
//  console.log (" --> " + JSON.stringify([messageId, requestId].concat(payload)))
  return connection.sendBytes(cbor.encode([messageId, requestId].concat(payload)));
}

function callInternal(messageId, payload, progressCallback, resultCallback) {
  while (nextRequestId in pendingRequests)
    ++nextRequestId;

  pendingRequests[nextRequestId] = {
    onprogress: progressCallback,
    onresult: resultCallback
  };

  sendInternal(reverseClient, messageId, nextRequestId, payload);
  ++nextRequestId;
  return 0;
}


var file = new static.Server('.');

var server = http.createServer(function(request, response) {
  console.log((new Date()) + ' Received request for ' + request.url);

  request.addListener('end', function () {
    file.serve(request, response);
  }).resume();
});

server.listen(8080, function() {
  console.log((new Date()) + ' Server is listening on port 8080');
});

wsServer = new WebSocketServer({
  httpServer: server,
  autoAcceptConnections: false
});

function originIsAllowed(origin) {
  // put logic here to detect whether the specified origin is allowed.
  return true;
}

wsServer.on('request', function(request) {
  if (!originIsAllowed(request.origin)) {
    // Make sure we only accept requests from an allowed origin
    request.reject();
    console.log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.');
    return;
  }

  var helloRequest = null;
  var subscriptions = [];
  var nextFreeSubscriptionId = 1;

  var reverse = request.requestedProtocols[0] == 'rwpcp';
  var connection = request.accept(reverse ? 'rwpcp' : 'wpcp', request.origin);
  if (reverse) {
    reverseClient = connection;
    console.log((new Date()) + ' Reverse connection accepted.');

    callInternal(0, [{}], function() {
    }, function(resultMessageId, resultPayload) {
      console.log((new Date()) + ' Reverse hello result: ' + JSON.stringify(resultPayload[0]));
    });
  } else
    console.log((new Date()) + ' Connection accepted.');

  connection.on('message', function(message) {
    if (message.type !== 'binary') {
      console.log((new Date()) + ' Received wrong message type: ' + message.type);
      return;
    }

    cbor.decode(message.binaryData, function(err, arr) {
      try {
        if (arr.length !== 1)
          throw 'Invalid CBOR message';

        var decoded = arr[0];
        var messageId = decoded[0];
        var requestId = decoded[1];
        var payload = decoded.slice(2);

        if (reverse) {
          if (reverseClient.methods) {
            if (messageId in reverseClient.methodIdCallback)
              reverseClient.methodIdCallback[messageId](messageId, requestId, payload);
            else
              console.error("Received invalid messageId " + messageId);
          } else {
            reverseClient.methods = payload[0].methods;
            reverseClient.methodIdCallback = {};
            reverseClient.methodIdType = {};

            var generalHandlers = {
              "publish": function(messageId, id, payload) {
                for (var i = 0; i < payload.length; i += 2) {
                  try {
                    sendInternal(reverseSubscriptions[payload[i]], messageId, 0, [payload[i], payload[i+1]]);
                  } catch (e) {
                    console.error(e);
                  }
                }
              },
              "result": function(messageId, requestId, payload) {
                pendingRequests[requestId].onresult(messageId, payload);
                delete pendingRequests[requestId];
                if (requestId < nextRequestId)
                  nextRequestId = requestId;
              },
              "progress": function(messageId, requestId, data) {
                catchThrow(self.pendingRequests[requestId].onprogress, data);
              }
            };

            var methods = reverseClient.methods;
            for (var i = 0; i < methods.length; i += 2) {
              var methodId = i / 2;
              var methodName = methods[i + 0];
              var methodType = methods[i + 1];

              switch (methodName) {
              case "processed":
                reverseClient.messageIdProcessed = methodId;
                break;

              case "cancelcall":
                reverseClient.messageIdCancelCall = methodId;
                break;

              default:
                if (methodName in generalHandlers)
                  reverseClient.methodIdCallback[methodId] = generalHandlers[methodName];
                else
                  reverseClient.methodIdType[methodId] = methodType;
              }
            }
          }
        } else if (!helloRequest) {
          helloRequest = payload[0];
          sendInternal(connection, 0, requestId, [{methods:reverseClient.methods}]);
        } else {
          if (messageId in reverseClient.methodIdType) {
            switch (reverseClient.methodIdType[messageId]) {
            case 1:
              callInternal(messageId, payload, function(progressMessageId, progressPayload) {
                sendInternal(connection, progressMessageId, requestId, progressPayload);
              }, function(resultMessageId, resultPayload) {
                sendInternal(connection, resultMessageId, requestId, resultPayload);
              });
              break;

            case 2:
            case 3:
            case 4:
              callInternal(messageId, payload, function(progressMessageId, progressPayload) {
                sendInternal(connection, progressMessageId, requestId, progressPayload);
              }, function(resultMessageId, resultPayload) {
                for (var i = 0; i < resultPayload.length; i += 2)
                  reverseSubscriptions[resultPayload[i / 2 + 1]] = connection;

                sendInternal(connection, resultMessageId, requestId, resultPayload);
              });
              break;

            default:
              console.error("invalid methodid")
            }
          } else if (messageId == reverseClient.messageIdProcessed) {
          } else if (messageId == reverseClient.messageIdCancelCall) {
          } else {
            console.error("invalid messageId");
          }
        }
      } catch (e) {
        console.error(e);
      }
    });
  });

  connection.on('close', function(reasonCode, description) {
    if (reverse) {
      console.log((new Date()) + ' Reverse Client disconnected.');
      reverseClient = null;
    }
    console.log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
  });
});
