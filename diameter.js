/**
 * Copyright 2013,2014 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    'use strict';
    var diameter  = require('diameter');
	var diameterCodec = require('diameter/lib/diameter-codec.js');
    const avp = require('diameter-avp-object');

    var nodes = [];
    var nodeSets = [];
	var requestID = 0;
	var responseNode =[];
	var destinations = [];


	function arrayRemove(arr, value) {

	   return arr.filter(function(ele){
		   return ele != value;
	   });

	}

	function makeBufferReadable(obj)
	{
		for (var k in obj){
			if (obj[k] instanceof Buffer){
				obj[k+"_readable"]= obj[k].toString();
				obj[k]= obj[k].toString('base64');	
			} else if (typeof obj[k] == "function"){
				delete obj[k];
			} else if (typeof obj[k] == "object" && obj[k] !== null){
				makeBufferReadable(obj[k]);
			}
		}
	}

   function DiameterDestinationNode(n) {
        var node = this;
        RED.nodes.createNode(node,n);
        node.name 				= n.name;
        node.host 				= n.host;
        node.port 				= n.port;
        node.diameterIdentity 	= n.diameterIdentity;
        node.diameterRealm 		= n.diameterRealm;
		
		destinations[node.diameterIdentity]=node;
    }
    RED.nodes.registerType("diameter-destination",DiameterDestinationNode);
	


   function DiameterHostNode(n) {
        var node = this;
		node.sockets=[];
		node.inNodes=[];
		node.events = [];
        RED.nodes.createNode(node,n);
        node.name 				= n.name;
        node.host 				= n.host;
        node.port 				= n.port;
        node.serverMode 		= n.serverMode;
        node.watchdogInterval 	= n.watchdogInterval || 60;
		node.timeout			= n.timeout || 300;
        node.keepalive 			= n.keepalive;
        node.diameterIdentity 	= n.diameterIdentity;
        node.diameterRealm 		= n.diameterRealm;
		if ((typeof n.applicationJson === 'string') && (n.applicationJson.length>0)){
			node.applicationJson = JSON.parse (n.applicationJson);
		} else {
			node.applicationJson = null;
		}		
        node.vendorId 			= n.vendorId;
        node.productName 		= n.productName || 'Node-Red Diameter';
		
		node.registerInNode=function (obj){
		   node.inNodes.push (obj);
		};

		node.sendResponse=function (requestID,response){
			if (typeof node.events[requestID] === 'object') {
				//node.error('Start Response-Processing ' + msg.requestID);
				node.events[requestID].response.body = node.events[requestID].response.body.concat([
					[ 'Origin-Host', node.diameterIdentity ],
					[ 'Origin-Realm', node.diameterRealm ]
				]);
				node.events[requestID].response.body = node.events[requestID].response.body.concat(response);
				//node.error('Merged response body: ' + JSON.stringify(events[msg.requestID].response.body));

				node.events[requestID].callback(node.events[requestID].response);	
				node.events=arrayRemove(node.events, requestID);	
				responseNode=arrayRemove(responseNode,requestID);
				node.log('Sent Response  ' + requestID);

				return true;
			} else {
				return false;
			}
		}


		node.createConnection=function(destinationHost) {
			return new Promise((resolve, reject) => {
				if (destinations [destinationHost]){
					if (node.sockets [destinationHost]){
						resolve (node.sockets [destinationHost]);
					} else {					
						var options = {
							beforeAnyMessage: diameter.logMessage,
							afterAnyMessage: diameter.logMessage,
							localAddress : node.host,
							port: destinations [destinationHost].port,
							host: destinations [destinationHost].host
						};
						node.log ('Start socket creation for ' + destinationHost);
						node.log ('Connection-Options: ' + JSON.stringify (options));
						var socket;
						socket=diameter.createConnection(options, function() {
							node.log ('Socket created. Start CER creation for ' + destinationHost);
							socket.destinationHost=destinationHost;
							socket.diameterMode='client';
							if (node.timeout>0)socket.setTimeout (node.timeout*1000);
							node.addSocketListener(socket);
                            
							var request = socket.diameterConnection.createRequest('Diameter Common Messages', 'Capabilities-Exchange');
							request.body = request.body.concat([
								[ 'Origin-Host', node.diameterIdentity ],
								[ 'Origin-Realm', node.diameterRealm ],
								[ 'Host-IP-Address', node.host ]
							]);
							if (node.vendorId){
								request.body = request.body.concat([
									[ 'Vendor-Id', node.vendorId ]
								]);						
							}
							
							if (node.productName){
								request.body = request.body.concat([
									[ 'Product-Name', node.productName ]
								]);						
							}
							if (Array.isArray(node.applicationJson)) request.body = request.body.concat(node.applicationJson);	
							node.log ('CER body created:  ' + JSON.stringify (request.body));
							
							socket.diameterConnection.sendRequest(request).then(function(response) {
								node.log ('Received CEA:' + JSON.stringify(response) );
								if (avp.toObject(response.body).resultCode=='DIAMETER_SUCCESS') {
									node.setSocket (destinationHost,socket);
									if (node.watchdogInterval>0) socket.watchdogTimeout=setTimeout (node.sendWatchdog,node.watchdogInterval*1000,destinationHost);							
									node.log('socket created and sent for ' + destinationHost);
									socket.on('diameterMessage',function (event) {node.processIncommingMessage(socket,event)});									
									resolve (socket);								
								} else {
									node.error('Error CEA Result Code: ' + JSON.stringify (response));
									socket.diameterConnection.end();
									reject ({message:'Error CEA Result Code: ' + JSON.stringify (response)});
								}
								
							}, function(error) {
								node.error('Error sending response: ' + error);
								socket.diameterConnection.end();
								reject ({message:'Error sending response: ' + error});
							});					
						});
					};
				} else {
					node.error('No destination host object found for: ' + destinationHost);
					reject ({message:'No destination host object found for: ' + destinationHost});
				}
			});
        };
	
		node.sendWatchdog=function (destinationHost){
			if (node.sockets[destinationHost]){
				node.log('Send DWR to ' + destinationHost);

				var socket =node.sockets[destinationHost];
				var request = socket.diameterConnection.createRequest('Diameter Common Messages', 'Device-Watchdog');
				request.body = request.body.concat([
					[ 'Origin-Host', node.diameterIdentity ],
					[ 'Origin-Realm', node.diameterRealm ]
					//[ 'Destination-Host', destinations [destinationHost].diameterIdentity ],
					//[ 'Destination-Realm', destinations [destinationHost].diameterRealm ]
				]);
				socket.diameterConnection.sendRequest(request).then(function(response) {
					node.log('Got DWA from ' + destinationHost);
					if (node.watchdogInterval>0) socket.watchdogTimeout=setTimeout (node.sendWatchdog,node.watchdogInterval*1000,destinationHost);				
				}, function(error) {	
					node.error('Got no DWA from ' + destinationHost + ": " + error );
					if (node.watchdogInterval>0) socket.watchdogTimeout=setTimeout (node.sendWatchdog,node.watchdogInterval*1000,destinationHost);
				});			
			}
		}							


		node.closeConnection=function (destinationHost,disconnectCause=null){
			if (node.sockets[destinationHost]){
				var socket =node.sockets[destinationHost];
				if (socket.watchdogTimeout){
					clearTimeout(socket.watchdogTimeout);
					delete (socket.watchdogTimeout);
				}				
				node.sockets=arrayRemove(node.sockets,destinationHost);	
				var request = socket.diameterConnection.createRequest('Diameter Common Messages', 'Disconnect-Peer');
				request.body = request.body.concat([
					[ 'Origin-Host', node.diameterIdentity ],
					[ 'Origin-Realm', node.diameterRealm ],
					//[ 'Destination-Host', destinations [destinationHost].diameterIdentity ],
					//[ 'Destination-Realm', destinations [destinationHost].diameterRealm ],
					[ 'Disconnect-Cause', disconnectCause || 'DO_NOT_WANT_TO_TALK_TO_YOU']
				]);
				socket.diameterConnection.sendRequest(request).then(function(response) {
					socket.diameterConnection.end();
				}, function(error) {
					socket.diameterConnection.end();
				});			
			}
		}

		node.processIncommingMessage=function(socket,event) {
			if (event.message.command === 'Capabilities-Exchange') {
				node.log ('Start CER processing');
				socket.destinationHost=avp.toObject(event.message.body).originHost;
				node.log ('Origin-Host: ' + socket.destinationHost);
				
				if (destinations[socket.destinationHost]){
					node.log ('Generate CEA for known host');
					socket.diameterMode='server';
					if (node.timeout>0)socket.setTimeout (node.timeout*1000);
					node.sockets[socket.destinationHost]=socket;
					event.response.body = event.response.body.concat([
						['Result-Code', 'DIAMETER_SUCCESS'],
						[ 'Origin-Host', node.diameterIdentity ],
						[ 'Origin-Realm', node.diameterRealm ],
						[ 'Host-IP-Address', node.host ]
					]);

					if (node.vendorId){
						event.response.body = event.response.body.concat([
							[ 'Vendor-Id', node.vendorId ]
						]);						
					}
					
					if (node.productName){
						event.response.body = event.response.body.concat([
							[ 'Product-Name', node.productName ]
						]);						
					}
					
					if (Array.isArray(node.applicationJson)) event.response.body = event.response.body.concat(node.applicationJson);	
					
					event.callback(event.response);
					node.log ('Sent CEA for peer: ' + socket.destinationHost);					
				} else {
					node.error ('Unknown peer: ' + socket.destinationHost);
					event.response.body = event.response.body.concat([
						[ 'Result-Code', 'DIAMETER_UNKNOWN_PEER'],
						[ 'Origin-Host', node.diameterIdentity ],
						[ 'Origin-Realm', node.diameterRealm ]
					]);
					event.callback(event.response);
					node.log ('Sent REA for peer: ' + socket.destinationHost);
					setTimeout (socket.diameterConnection.end,1000);
				}
			} else if (event.message.command === 'Device-Watchdog') {
				node.log ('Start DWR processing');
				node.log ('Origin-Host: ' + socket.destinationHost);
				
				event.response.body = event.response.body.concat([
					[ 'Result-Code', 'DIAMETER_SUCCESS'],
					[ 'Origin-Host', node.diameterIdentity ],
					[ 'Origin-Realm', node.diameterRealm ]
				]);

				event.callback(event.response);
				node.log ('Sent DWA for peer: ' + socket.destinationHost);					
			} else if (event.message.command === 'Disconnect-Peer') {
				node.log ('Start DPR processing');
				node.log ('Origin-Host: ' + socket.destinationHost + ' Disconnect-Cause:' + avp.toObject(event.message.body).disconnectCause);
				
				event.response.body = event.response.body.concat([
					[ 'Result-Code', 'DIAMETER_SUCCESS'],
					[ 'Origin-Host', node.diameterIdentity ],
					[ 'Origin-Realm', node.diameterRealm ]
				]);

				event.callback(event.response);
				node.log ('Sent DPA for peer: ' + socket.destinationHost);					
				setTimeout (socket.diameterConnection.end,1000);
				
			} else {
				requestID++;
				var currentRequestID=requestID;
				responseNode [currentRequestID]=node;
				node.events[currentRequestID]=event;
				node.inNodes.forEach(function(value, index, array) {array[index].incommingMessage (event,requestID)});
			}

		}
		
		node.addSocketListener=function (socket) {
			socket.on('end', function() {
				node.log('Socket end. Peer ' + socket.destinationHost + ' disconnected.');
				if (socket.destinationHost && node.sockets [socket.destinationHost]){
					node.sockets=arrayRemove(node.sockets,socket.destinationHost);					
					if (socket.watchdogTimeout){
						clearTimeout(socket.watchdogTimeout);
						delete (socket.watchdogTimeout);
					}					
					socket.destroy();
				}
			});		
			socket.on('timeout', function() {
				node.log('Socket Timeout. Peer ' + socket.destinationHost + ' disconnected.');
				if (socket.destinationHost && node.sockets [socket.destinationHost]){
					node.sockets=arrayRemove(node.sockets,socket.destinationHost);	
					if (socket.watchdogTimeout){
						clearTimeout(socket.watchdogTimeout);
						delete (socket.watchdogTimeout);
					}
					socket.destroy();
				}
			});			
			
			socket.on('error', function(err) {
				if (typeof err =="string"){
					node.error('Got socket error: ' + err)
				} else {
					node.error('Got socket error: ' + JSON.stringify (err)+ err)				
				}
				if (socket.destinationHost && node.sockets [socket.destinationHost]){
					node.sockets[socket.destinationHost].end();
					node.sockets=arrayRemove(node.sockets,socket.destinationHost);					
				}
			});		
		}

		node.setSocket=function (destinationHost,socket){
			if (node.sockets[destinationHost] && node.sockets[destinationHost].watchdogTimeout){
				clearTimeout(node.sockets[destinationHost].watchdogTimeout);
			}
			node.sockets[destinationHost]=socket;
		}
		
		node.addServerSocket=function (socket) {
			socket.on('diameterMessage',function (event) {node.processIncommingMessage(socket,event)});
			node.addSocketListener(socket);
		}

			
		node.sendMessage=function(requestAVP,destinationHost,command,application,sessionId) {
			return new Promise((resolve, reject) => {			
				var result={};
				node.createConnection (destinationHost)
				.then (socket => {
					if (socket){	
						var	request = socket.diameterConnection.createRequest(application || 'Diameter Common Messages', command,sessionId);
						request.body = request.body.concat([
							[ 'Origin-Host', node.diameterIdentity ],
							[ 'Origin-Realm', node.diameterRealm ],
							[ 'Destination-Host', destinations [destinationHost].diameterIdentity ],
							[ 'Destination-Realm', destinations [destinationHost].diameterRealm ]							
						]);
						if (Array.isArray(requestAVP))	request.body = request.body.concat(requestAVP);		
						//node.error ('Test 2: ' + JSON.stringify (request));
						socket.diameterConnection.sendRequest(request,10000).then(function(response) {
							result.result="ok";
							result.request=request;
							result.response=response;
							if ((!node.keepalive) && socket.diameterMode=='client') node.closeConnection (destinationHost)	
							resolve (result);
						}, function(error) {
							node.error('Error sending request: ' + error);
							result.result="error";
							result.error=error;
							resolve (result);
						});							
						
					} else {
						result.result="error";
						result.error={message:"Got no socket object " + JSON.stringify (socket)};
						resolve (result);
					}
				})
				.catch (error => {
					node.error("Got error from connection promise " + JSON.stringify (error));
					reject (error);			
				})
			});
        };
				
		node.server = diameter.createServer({beforeAnyMessage: diameter.logMessage,afterAnyMessage: diameter.logMessage}, node.addServerSocket);

		if (node.serverMode) {
			node.server.listen(node.port, node.host);
			node.log('Started DIAMETER server on ' + node.host + ':' + node.port);		
			node.status({fill: 'green', shape: 'dot', text: 'Started on '+ node.host + ':' + node.port});
		}
        node.on('close', function() {
            node.server.close();
			node.sockets.forEach(function(value, index, array) {node.closeConnection (index)});
			node.log('Closed DIAMETER server on ' + node.host + ':' + node.port);		
			node.status({fill: 'red', shape: 'dot', text: 'Stopped'});
        });

 				
    }
    RED.nodes.registerType("diameter-host",DiameterHostNode);


    function DiameterInNode(n) {
        var node = this;	
        RED.nodes.createNode(node,n);

        node.diameterHost	      	= RED.nodes.getNode(n.diameterHostId);
		node.diameterDestination	= RED.nodes.getNode(n.diameterDestination);
 		
		
		node.incommingMessage=function(event,requestID) {
			try {
				node.send({
					application			: event.message.application,
					command				: event.message.command,
					message				: event.message,
					messageEnc			: diameterCodec.encodeMessage(event.message),
					payload				: event.response.body,
					
					ownHostAddress		: node.diameterHost.host,
					ownHostPort			: node.diameterHost.Port,
					ownDiameterIdentity	: node.diameterHost.diameterIdentity,
					ownVendorId			: node.diameterHost.vendorId,
					ownReam				: node.diameterHost.diameterRealm,
					productName			: node.diameterHost.productName,
					requestID			: requestID,
					avp					: avp.toObject(event.message.body)
				});
			} catch (err){
				node.error('Error parsing request: ' + err.message);
				node.status({fill: 'red', shape: 'dot', text: 'Error parsing request: ' + err.message});
			}
		};
		node.diameterHost.registerInNode(node);
    }
    RED.nodes.registerType('Diameter in', DiameterInNode);

    function DiameterOutNode(n) {
        var node = this;
		
        RED.nodes.createNode(node,n);

        node.on('input', function(msg) {
			try {
				if (responseNode[msg.requestID].sendResponse (msg.requestID,msg.payload))
					node.status({fill: 'green', shape: 'dot', text: 'Sent response'});
				else
					node.status({fill: 'red', shape: 'dot', text: 'Sent failed. No event found.'});
			} catch (err){
				node.error('Error sending response: ' + err.message +(err.fileName? ' Filename ' + err.fileName :'')+(err.lineNumber? ' line number ' + err.lineNumber :''));
				node.status({fill: 'red', shape: 'dot', text: 'Error sending response: ' + err.message});
			}					
        });

    }
    RED.nodes.registerType('Diameter out', DiameterOutNode);

    function DiameterSendNode(n) {
        var node = this;
		RED.nodes.createNode(node,n);
        node.diameterHost      		= RED.nodes.getNode(n.diameterHostId);
		node.diameterDestination	= RED.nodes.getNode(n.diameterDestination);

        node.on('input', function(msg) {
			node.diameterHost.sendMessage(msg.payload,(msg.destinationHost && msg.destinationHost.length>0?msg.destinationHost: node.diameterDestination.diameterIdentity),msg.command,msg.application,msg.sessionId)
			.then (result => {
				if (result.result=="ok"){
					node.status({fill: 'green', shape: 'dot', text: 'Got response for Request'});
					msg.payload=result.response.body;
					msg.diameterRequestEnc=diameterCodec.encodeMessage(result.request);
					msg.diameterResponseEnc=diameterCodec.encodeMessage(result.response);
					msg.diameterRequest=result.request;
					msg.diameterRequest.body=avp.toObject(result.request.body);
					makeBufferReadable(msg.diameterRequest.body);
					msg.diameterResponse=result.response;
					msg.diameterResponse.body=avp.toObject(result.response.body);
					makeBufferReadable(msg.diameterResponse.body);
					msg.result="ok";
					node.send(msg);	
				} else {
					// handle response
					node.error('Error sending request: ' + JSON.stringify (result));
					node.status({fill: 'red', shape: 'dot', text: 'Error sending request: ' + JSON.stringify (result.error)});
					msg.payload={};
					msg.result="error";
					msg.error=result.error;
					node.send(msg);	
				};
			})
			.catch (error => {
				node.error('Error sending request (catch): ' + error);
				node.status({fill: 'red', shape: 'dot', text: 'Error sending request (catch): ' + JSON.stringify (error)});
				msg.payload={};
				msg.result="error";
				msg.error=error;
				node.send(msg);				
			});
		});
	};		
    RED.nodes.registerType('Diameter send', DiameterSendNode);
};