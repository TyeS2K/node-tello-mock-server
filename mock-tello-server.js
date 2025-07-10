var express = require('express');
var bodyParser = require('body-parser');
var WebSocket = require('ws');
var http = require('http');

// Create server and WebSocket container
var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ server: server });

app.use(bodyParser.json());

var DRONES = {};
var CLIENTS = {}; // connected clients per drone

var actionScripts = {};

// === Drone Simulator ===
function createDrone(id, ip) {
    return {
        id: id,
		ip: ip,
        connected: false,
		streamon: false,
        inFlight: false,
		range: 4500,
        battery: 100,
        yaw: 0, // initial facing angle
        position: { x: 0, y: 0, z: 0 },
        status: 'idle',
        commandQueue: []
    };
}

// Initialize random drones
var droneCount = 4; // Math.floor(Math.random() * 4) + 2;
for (var i = 1; i <= droneCount; i++) {
    DRONES['tello-' + i] = createDrone('tello-' + i, '127.0.0.' + (100 + i));
}

// === API Endpoints ===
console.log('  - Adding CROSS ORIGIN headers.');
app.use((req, res, next) => {
	res.set({
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept'
	});
	next();
});

// List available drones
app.get('/discovery', function (req, res) {
    var list = [];
    for (var id in DRONES) {
        list.push({
            id: id,
			ip: DRONES[id].ip,
			range: DRONES[id].range,
            streamon: DRONES[id].streamon,
            connected: DRONES[id].connected,
            status: DRONES[id].status
        });
    }
    res.json({ drones: list });
});
app.get('/elevation', function (req, res) {
	var qry = req.query;
	
	res.json({ elevation: 35 });
	/*
	var url = 'https://api.open-elevation.com/api/v1/lookup?locations=' + qry.lat + ',' + qry.lon;
	fetch(url)
		.then(function (response) {
			return response.json();
		})
		.then(function (data) {
			console.log(data);
			res.json({ elevation: data.results[0].elevation });
		});
	*/
});
app.get('/location', function (req, res) {
    var qry = req.query;

	var url = 'https://ipwho.is' + (qry.ip ? ('/' + qry.ip) : '');
	fetch(url)
		.then(function (response) {
			return response.json();
		})
		.then(function (data) {
			// console.log(data);
			res.json({ location: data });
		});
});

// Connect to a drone
app.post('/connect', function (req, res) {
    var id = req.body.id;
    var drone = DRONES[id];

    if (!drone) return res.status(404).json({ error: 'Drone not found' });
    if (drone.connected) return res.status(400).json({ error: 'Already connected' });

    drone.connected = true;
    drone.status = 'connected';

    res.json({ message: 'Connected to ' + id });
});

// Connect to a drone
app.post('/disconnect', function (req, res) {
    var id = req.body.id;
    var drone = DRONES[id];

    if (!drone) return res.status(404).json({ error: 'Drone not found' });
    if (!drone.connected) return res.status(400).json({ error: 'Not connected' });

	drone.commandQueue = '';
    drone.connected = false;
    drone.status = 'idle';

    res.json({ message: 'Disconnected from ' + id });
});

app.get('/info/:id', function (req, res) {
    var id = req.params.id;
    var drone = DRONES[id];
    if (!drone || !drone.connected) return res.status(400).json({ error: 'Drone not found' });

    res.json({ info: drone });
});

// Send flight path
app.post('/flightpath', function (req, res) {
    var id = req.body.id;
    var commands = req.body.commands;

    var drone = DRONES[id];
    if (!drone || !drone.connected) return res.status(400).json({ error: 'Drone not connected' });

	// Store commands.zones to actionScript()
	// Object assign, or possibly replace.
	
	if (!actionScripts[id]) { actionScripts[id] = {}; }
	
	// Transpose script to array of cmds.
	for (var z in commands.zones) {
		zone = commands.zones[z];
		if (typeof(zone.script) == 'string') {
			zone.script = zone.script.split('\n');
		} else if (!Array.isArray(zone.script)) {
			zone.script = [];
		}
	}
	actionScripts[id] = Object.assign({}, commands.zones);
    drone.commandQueue = commands.path;
	drone.position = { x: 0, y: 0, z: 0 };
	drone.yaw = 0;
    drone.status = 'in-flight';
    drone.inFlight = true;

    simulateDroneFlight(drone);

    res.json({ message: 'Flight path sent to ' + id });
});


// Handles directional movement in current yaw frame
function moveRelative(drone, direction, distance) {
    const radians = drone.yaw * (Math.PI / 180);
    const dx = Math.sin(radians) * distance; // East offset
    const dy = Math.cos(radians) * distance; // North offset

    switch (direction) {
        case 'forward':
            drone.position.x += dx; // east
            drone.position.y += dy; // north
            break;
        case 'back':
            drone.position.x -= dx;
            drone.position.y -= dy;
            break;
        case 'left':
            drone.position.x -= dy;
            drone.position.y += dx;
            break;
        case 'right':
            drone.position.x += dy;
            drone.position.y -= dx;
            break;
        case 'up':
            drone.position.z += distance;
            break;
        case 'down':
            drone.position.z -= distance;
            break;
    }
}

function simulateDroneFlight(drone) {
	var state = {zone: ''};
    if (typeof drone.yaw === 'undefined') {
        drone.yaw = 0; // facing north
    }

    function executeNext() {
        if (drone.commandQueue.length === 0) {
            drone.inFlight = false;
            drone.status = 'complete';
            broadcastStatus(drone);
            return;
        }

        var cmd = drone.commandQueue.shift();
        drone.status = 'executing: ' + cmd;
        var parts = cmd.trim().split(/\s+/);
        var base = parts[0];

        switch (base) {
            case 'action':
				// load script of special commands.
				var zone = parts[1];
				if (actionScripts[drone.id][zone]) {
					// Save the zone to the state.
					state.zone = zone;
					
					if (actionScripts[drone.id][zone].script.length > 0) {
						var savedPos = {
							x: drone.position.x,
							y: drone.position.y,
							z: drone.position.z
						};
						var savedYaw = drone.yaw;

						var dx = -Math.round(drone.position.x - savedPos.x);
						var dy = -Math.round(drone.position.y - savedPos.y);
						var dz = -Math.round(drone.position.z - savedPos.z);
						var yawDiff = (360 - drone.yaw) % 360;

						var returnScript = [
							'go ' + dx + ' ' + dy + ' ' + dz + ' 50',
							'ccw ' + yawDiff
						];

						// console.log('yaw   = ' + drone.yaw);
						// console.log('yaw.diff = ' + yawDiff);
						
						var injected = actionScripts[drone.id][zone].script.slice().concat(returnScript);
						drone.commandQueue = injected.concat(drone.commandQueue);
					}
				}
				break;
				
			case 'record':
				// Fire off recording event to Node server
				// if camera is turned on.
				// TODO: Add udp video express endpoint.
				//
				if (drone.streamon) {
				// var [_, seconds] = parts.map(Number);
				// var http = require('http');
				// http.get('http://localhost:3000/record/' + state.zone + '/' + seconds, function (res) {
					// console.log('Video recording started for Zone1');
				// });
				}
				break;
				
            case 'streamon':
				if (!drone.streamon) {
					drone.streamon = true;
					// TODO Send command.
				}
				break;
			case 'streamoff':
                drone.streamon = false;
				// TODO Send command.
				break;
				
            case 'takeoff':
                drone.position.z = 80;
                drone.status = 'takeoff';
                break;

            case 'land':
                drone.position.z = 0;
                drone.status = 'landed';
                break;

            case 'cw':
            case 'ccw':
                var angle = parseInt(parts[1], 10);
                drone.yaw = (base === 'cw')
                    ? (drone.yaw + angle) % 360
                    : (drone.yaw - angle + 360) % 360;
                break;

            case 'go':
                if (parts.length >= 5) {
                    var [_, x, y, z, speed] = parts.map(Number);
                    drone.position.x += x;
                    drone.position.y += y;
                    drone.position.z += z;
                }
                break;

            case 'curve':
                if (parts.length >= 8) {
                    var [_, x1, y1, z1, x2, y2, z2, speed] = parts.map(Number);
                    drone.position.x += x2;
                    drone.position.y += y2;
                    drone.position.z += z2;
                }
                break;

			case 'clear':
				drone.commandQueue.length =0;
				break;
			case 'reset-dir':
				if (drone.yaw > 0) {
					drone.commandQueue.unshift(`ccw ${drone.yaw}`);
				} else if (drone.yaw < 0) {
					drone.commandQueue.unshift(`cw ${Math.abs(drone.yaw)}`);
				}
				break;
				
            case 'forward':
            case 'back':
            case 'left':
            case 'right':
            case 'up':
            case 'down':
                var distance = parseInt(parts[1], 10);
                moveRelative(drone, base, distance);
                break;

            case 'wait':
                var duration = parseInt(parts[1], 10) || 1000;
                setTimeout(function () {
                    broadcastStatus(drone);
                    executeNext(); // continue after wait
                }, duration);
                return;
        }

        broadcastStatus(drone);
        setTimeout(executeNext, 500);
    }

    executeNext();
}

// === WebSocket Live Status ===
function broadcastStatus(drone) {
    var payload = JSON.stringify({
        type: 'status',
        drone: {
			id: drone.id,
			connected: drone.connected,
			status: drone.status,
			battery: drone.battery,
			position: drone.position,
			yaw: drone.yaw,
			inFlight: drone.inFlight
		}
    });

    wss.clients.forEach(function (client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

wss.on('connection', function (ws) {
    console.log('WebSocket client connected');
    ws.send(JSON.stringify({ type: 'info', message: 'Connected to Tello Mock Server' }));
});

// Start server
var PORT = 3000;
server.listen(PORT, function () {
    console.log('Tello Mock Server running on http://localhost:' + PORT);
});
