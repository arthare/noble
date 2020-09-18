/* jshint loopfunc: true */
var WebSocket = require('ws');
var fs = require('fs');
var Peripheral = require('./lib/peripheral');

var noble = require('./index');

var defaultScanUuid = process.argv[3] || "1818";
var g_fEnableRealScanning = true;
var child_process = require('child_process');

var wss;
function assert(f, reason) {
  if(!f) {
    console.log(reason);
    debugger;
  }
}

const ConnectionState_Disconnected = 0;
const ConnectionState_Connecting = 1;
const ConnectionState_Connected = 2;
class NobleClientContext {
  peripherals = {};
  ws = null;
  connectionState = ConnectionState_Disconnected;
  id = -1;

  activeScanServiceUuids = [];

  constructor(ws, id) {
    this.ws = ws;
    this.peripherals = {};
    this.connectionState = ConnectionState_Disconnected;
    this.allowDuplicates = false;
    this.id = id;
    this.uuidConnected = null;
  }

  startScanning(serviceUuids, allowDuplicates) {
    this.allowDuplicates = allowDuplicates;
    this.activeScanServiceUuids = serviceUuids;
    assert(serviceUuids.length > 0, "you gotta actually want to be scanning, right?");
  }
  stopScanning() {
    this.activeScanServiceUuids = [];
  }
  isConnecting() {
    return this.connectionState === ConnectionState_Connecting;
  }
  isConnected() {
    return this.connectionState === ConnectionState_Connected;
  }
  getConnectedUuid() {
    return this.uuidConnected;
  }
  setConnected(connectionState, uuidToWho) {
    this.connectionState = connectionState;
    if(connectionState !== ConnectionState_Disconnected) {
      this.uuidConnected = uuidToWho;
    } else {
      assert(uuidToWho === null);
      this.uuidConnected = null;
    }
  }
  isScanningForPeripheral(initialAdvertisement) {
    if(!initialAdvertisement) {
      // they're just asking if we're scanning at all
      return this.activeScanServiceUuids.length > 0;
    }
    if(initialAdvertisement && initialAdvertisement.serviceUuids) {
      return initialAdvertisement.serviceUuids.find((advertisedUuid) => {
        const scannedFor = this.activeScanServiceUuids.find((scannedUuid) => scannedUuid === advertisedUuid);
        return !!scannedFor;
      })
    }
    return false;
  }
}

const contexts = {};
let nextContextId = 0;


var g_currentScanUuids = [];
var g_fStoppedScanning = true;

if(defaultScanUuid) {
  g_currentScanUuids = [defaultScanUuid];
}

console.log('noble - ws slave - server mode');

const scanPort = 0xb1d;
const myScanServer = new WebSocket.Server({
  port: scanPort
});
myScanServer.on('connection', (socket) => {
  console.log("scan server received incoming socket");
  socket.on('message', (msg) => {
    const data = JSON.parse(msg);

    if(data.evt === 'discover') {
      // the scanner process has found a thing!  let's see which of our contexts would be interested in it.
      const periph = data.data;
      noble.onReviveStoredPeripheral(periph.uuid, periph.address, periph.addressType, periph.connectable, periph.advertisement, periph.rssi);
    }

  })
});
myScanServer.on('error', (err) => {
  console.log("scan server had error", err);
})
let runArgs = process.argv.slice(1);
runArgs = runArgs.map((arg) => arg.replace("ws-slave", "scanner"));
console.log("making new scan process with ", runArgs);
const permaScanner = child_process.spawn("node", runArgs);
permaScanner.on('close', (code) => {
  console.log("scanner process closed ", code);
  process.exit(1);
})
permaScanner.on('exit', (code) => {
  console.log("scanner process exit ", code);
  process.exit(1);
})
permaScanner.stdout.on('data', (chunk) => {
  console.log("SCANPROC STDOUT: " + chunk.toString());
})
permaScanner.stderr.on('data', (chunk) => {
  console.error("SCANPROC STDERR: " + chunk.toString());
})




const controlPort = 0xb1f;
const myControlSocket = new WebSocket(`ws://localhost:${controlPort}`);
myControlSocket.on('message', (msg) => {
  
})
myControlSocket.on('close', () => {
  // if our host closes, so do we.
  console.log("Main OMP app closed, so we shall too");
  //process.exit(0);
});
myControlSocket.on('error', () => {
  // if we can't connect to our host, we close
  console.log("Main OMP app closed, so we shall too");
  //process.exit(0);
})

wss = new WebSocket.Server({
  port: 0xB1e
});
wss.on('connection', function (ws) {
  console.log('ws -> connection');

  const contextId = '' + nextContextId++;
  ws.contextId = contextId;
  contexts[contextId] = new NobleClientContext(ws, contextId);

  if(contextId === 'eventNames') {debugger;}
  ws.on('message', (evt) => {
    onMessage(contextId, evt);
  });

  ws.on('close', function () {
    console.log(`ws -> close ${contextId}`);

    const ctx = contexts[contextId];

    // go through all the peripherals connected to this websocket connection
    for(var key in ctx.peripherals) {
      const p = ctx.peripherals[key];

      // if this peripheral was actively connected to this websocket, treat the bluetooth connection like it died.
      // and also, make sure the bluetooth connection gets killed
      if(p.contextId === contextId) {
        p.disconnect();
        ctx.setConnected(ConnectionState_Disconnected, null);
      }
    }
    delete contexts[contextId];

    let contextsLeft = 0;
    for(var key in contexts) {
      contextsLeft++;
    }
    console.log("There are ", contextsLeft, "contexts left");


    noble.removeAllListeners('stateChange');
    ws.removeAllListeners('close');
    ws.removeAllListeners('open');
    ws.removeAllListeners('message');
  });

  noble.on('stateChange', function (state) {
    sendEvent(contextId, {
      type: 'stateChange',
      state: state
    });
  });

  // Send poweredOn if already in this state.
  if (noble.state === 'poweredOn') {
    sendEvent(contextId, {
      type: 'stateChange',
      state: 'poweredOn'
    });
  }
});


// TODO: open/close ws on state change

function sendEvent (contextId, event) {
  if(!event) {
    debugger;
  }
  var message = JSON.stringify(event);

  if(!event.serviceUuid || (event.serviceUuid !== "1818")) {
    //console.log(`ws -> send ${contextId}: ${message}`);
  }

  const ctx = contexts[contextId];
  if(!ctx) {
    // err, guess this guy disconnected?
    //console.log("they wanted to send a message ", message, " to context " + contextId);
    return;
  }
  const ws = contexts[contextId].ws;
  ws.send(message);
}

function isAnyContextScanning() {
  for(var key in contexts) {
    const ctx = contexts[key];
    if(key === 'eventNames') {debugger;}
    if(ctx.isScanningForPeripheral()) {
      return true;
    }
  }
  return false;
}
function isAnyContextConnectedTo(uuid) {
  for(var key in contexts) {
    const ctx = contexts[key];
    if(key === 'eventNames') {debugger;}
    if(ctx.isConnected() && ctx.getConnectedUuid() === uuid) {
      return true;
    }
  }
  return false;
}
function isAnyContextConnectingTo(uuid) {
  for(var key in contexts) {
    const ctx = contexts[key];
    if(key === 'eventNames') {debugger;}
    if(ctx.isConnecting() && ctx.getConnectedUuid() === uuid) {
      return true;
    }
  }
  return false;
}
function isAnyContextConnecting() {
  for(var key in contexts) {

    const ctx = contexts[key];
    if(ctx.isConnecting()) {
      return true;
    }
  }
  return false;
}
function isAnyContextConnected() {
  for(var key in contexts) {

    const ctx = contexts[key];
    if(ctx.isConnected()) {
      return true;
    }
  }
  return false;
}

class Deferred {
  resolve;
  reject;
  promise;
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

var connectSerialize = Promise.resolve();


class NoticedPeripheral {
  peripheral;
  advertisement;
  tmNow;

  constructor(peripheral, tmNow) {
    this.peripheral = peripheral;
    this.advertisement = JSON.parse(JSON.stringify(peripheral.advertisement));

    assert(this.advertisement.serviceUuids.length > 0, "we can't have a noticed periph with no service uuids");

    this.tmNow = tmNow;
  }

  toSaveable() {
    return {
      peripheral: JSON.parse(this.peripheral.toString()),
      advertisement: this.advertisement,
    }
  }
};

function handleDiscoveredPeripheral(peripheral, initialAdvertisement) {

  for(var key in contexts) {
    const ctx = contexts[key];

    if(!ctx.isScanningForPeripheral()) {
      // if you're simply not scanning, that's totally fine
      continue;
    }

    if(ctx.isScanningForPeripheral(initialAdvertisement)) {
      const oldPeripheral = ctx.peripherals[peripheral.uuid];
      if(oldPeripheral) {
        // we already knew about this guy, no updates needed
      } else {
        assert(peripheral._noble, "peripheral has to have noble!");
        ctx.peripherals[peripheral.uuid] = peripheral;
      }

      //console.log("context ", ctx.id, " is scanning for ", peripheral.advertisement.localName);

      const uuidsTouse = initialAdvertisement && initialAdvertisement.serviceUuids || peripheral.advertisement && peripheral.advertisement.serviceUuids;
      const sendObj = {
        type: 'discover',
        peripheralUuid: peripheral.uuid,
        address: peripheral.address,
        addressType: peripheral.addressType,
        connectable: peripheral.connectable,
        advertisement: {
          localName: peripheral.advertisement.localName,
          txPowerLevel: peripheral.advertisement.txPowerLevel,
          serviceUuids: uuidsTouse,
          manufacturerData: (peripheral.advertisement.manufacturerData ? peripheral.advertisement.manufacturerData.toString('hex') : null),
          serviceData: (peripheral.advertisement.serviceData ? peripheral.advertisement.serviceData.toString('hex') : null)
        },
        rssi: peripheral.rssi
      }
      sendEvent(key, sendObj);

    } else {
      //console.log("context ", ctx.id, " is NOT scanning for ", peripheral.advertisement.localName, " which has ", peripheral.advertisement.serviceUuids, " b/c ctx wants ", ctx.activeScanServiceUuids);
    }
  }
}

function handleScanningRequestFromContext(ctx, serviceUuids, allowDuplicates) {

  // nobody is currently connected, so we can start scanning.
  ctx.startScanning(serviceUuids, allowDuplicates);
}


var onMessage = function (contextId, message) {

  var command = JSON.parse(message);

  var action = command.action;
  var peripheralUuid = command.peripheralUuid;
  var serviceUuids = command.serviceUuids;
  var serviceUuid = command.serviceUuid;
  var characteristicUuids = command.characteristicUuids;
  var characteristicUuid = command.characteristicUuid;
  var data = command.data ? Buffer.from(command.data, 'hex') : null;
  var withoutResponse = command.withoutResponse;
  var broadcast = command.broadcast;
  var notify = command.notify;
  var descriptorUuid = command.descriptorUuid;
  var handle;

  if(action !== 'write') {
    console.log(contextId + ": " + action);
  }


  const ctx = contexts[contextId];

  var peripheral = ctx.peripherals[peripheralUuid];
  assert(!peripheral || peripheral._noble, "we need noble!");

  var service = null;
  var characteristic = null;
  var descriptor = null;

  if (peripheral && serviceUuid) {
    var services = peripheral.services;

    for (var i in services) {
      if (services[i].uuid === serviceUuid) {
        service = services[i];

        if (characteristicUuid) {
          var characteristics = service.characteristics;

          for (var j in characteristics) {
            if (characteristics[j].uuid === characteristicUuid) {
              characteristic = characteristics[j];

              if (descriptorUuid) {
                var descriptors = characteristic.descriptors;

                for (var k in descriptors) {
                  if (descriptors[k].uuid === descriptorUuid) {
                    descriptor = descriptors[k];
                    break;
                  }
                }
              }
              break;
            }
          }
        }
        break;
      }
    }
  }

  if (action === 'startScanning') {

    // if no context is scanning right now, start a scan for absolutely everything.
    // we will narrow things down later and send messages to relevant listeners in the 'discover' handler

    handleScanningRequestFromContext(ctx, serviceUuids, command.allowDuplicates);


  } else if (action === 'stopScanning') {
    ctx.stopScanning();
  } else if (action === 'connect') {

    peripheral.removeAllListeners('connect');
    peripheral.once('connect', function (error) {
      if(error) {
        ctx.setConnected(ConnectionState_Disconnected, null);
        console.log(contextId + "connect ERROR callback happened to ws-slave for " + peripheral.advertisement.localName + " and context " + contextId);
        sendEvent(contextId, {
          type: 'connect',
          error,
          peripheralUuid: this.uuid
        });

      } else {
        ctx.setConnected(ConnectionState_Connected, this.uuid);
        console.log(contextId + "connect callback happened to ws-slave for " + peripheral.advertisement.localName + " and context " + contextId);
        sendEvent(contextId, {
          type: 'connect',
          peripheralUuid: this.uuid
        });

      }
    });
    peripheral.removeAllListeners('disconnect');
    peripheral.once('disconnect', function () {
      console.log("got disconnect event from peripheral ", peripheral.pCounter, peripheral.advertisement.localName);
      ctx.setConnected(ConnectionState_Disconnected, null);
      sendEvent(contextId, {
        type: 'disconnect',
        peripheralUuid: this.uuid
      });
  
      wipeOldListeners(peripheral, true);
      peripheral.contextId = null;
    });

    if(ctx.isConnected() && ctx.getConnectedUuid() === peripheralUuid) {
      // uhh... you were already connected...
      const name = peripheral.advertisement.localName;
      console.log(contextId + " hey dingus, you were already connected to " + name + ", but we're going to allow this");
      sendEvent(contextId, {
        type: 'connect',
        peripheralUuid: this.uuid
      });
    } else {
      console.log(contextId + "ws-slave connection to " + peripheral.advertisement.localName + " starting");
      ctx.setConnected(ConnectionState_Connecting, peripheralUuid);
      peripheral.connect(undefined, contextId);
    }

    

  } else if (action === 'disconnect') {
    //console.log(contextId + " telling " + peripheral.pCounter + " / " + peripheral.advertisement.localName + " to disconnect");
    peripheral.disconnect();
  } else if (action === 'updateRssi') {
    peripheral.once('rssiUpdate',  (rssi) => {
      sendEvent(key, {
        type: 'rssiUpdate',
        peripheralUuid: peripheral.uuid,
        rssi: rssi
      });
    });
    peripheral.updateRssi();
  } else if (action === 'discoverServices') {


    peripheral.once('servicesDiscover', function (err, services) {
      //console.log("servicesDiscover callback for " + peripheral.uuid);

      var serviceUuids = services.map((service) => service.uuid);

      sendEvent(contextId, {
        type: 'servicesDiscover',
        peripheralUuid: this.uuid,
        serviceUuids: serviceUuids
      });
    });
    peripheral.discoverServices(command.uuids);
  } else if (action === 'discoverIncludedServices') {
    service.once('includedServicesDiscover', (includedServiceUuids) => {
      sendEvent(contextId, {
        type: 'includedServicesDiscover',
        peripheralUuid: peripheral.uuid,
        serviceUuid: this.uuid,
        includedServiceUuids: includedServiceUuids
      });
    });

    service.discoverIncludedServices(serviceUuids);
  } else if (action === 'discoverCharacteristics') {
    service.once('characteristicsDiscover', (characteristics) => {

      var discoveredCharacteristics = [];

      var read = function (data, isNotification) {
        var characteristic = this;

        sendEvent(contextId, {
          type: 'read',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          data: data.toString('hex'),
          isNotification: isNotification
        });
      };


      var broadcast = function (state) {
        var characteristic = this;

        sendEvent(contextId, {
          type: 'broadcast',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          state: state
        });
      };

      var notify = function (state) {
        var characteristic = this;

        sendEvent(contextId, {
          type: 'notify',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: characteristic.uuid,
          state: state
        });
      };

      var descriptorsDiscover = function (descriptors) {
        var characteristic = this;

        var discoveredDescriptors = [];

        var valueRead = function (data) {
          var descriptor = this;

          sendEvent(contextId, {
            type: 'valueRead',
            peripheralUuid: peripheral.uuid,
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
            descriptorUuid: descriptor.uuid,
            data: data.toString('hex')
          });
        };

        var valueWrite = function (data) {
          var descriptor = this;

          sendEvent(contextId, {
            type: 'valueWrite',
            peripheralUuid: peripheral.uuid,
            serviceUuid: service.uuid,
            characteristicUuid: characteristic.uuid,
            descriptorUuid: descriptor.uuid
          });
        };

        for (var k in descriptors) {
          descriptors[k].on('valueRead', valueRead);

          descriptors[k].on('valueWrite', valueWrite);

          discoveredDescriptors.push(descriptors[k].uuid);
        }

        sendEvent(contextId, {
          type: 'descriptorsDiscover',
          peripheralUuid: peripheral.uuid,
          serviceUuid: service.uuid,
          characteristicUuid: this.uuid,
          descriptors: discoveredDescriptors
        });
      };

      for (var j = 0; j < characteristics.length; j++) {
        characteristics[j].on('read', read);


        characteristics[j].on('broadcast', broadcast);

        characteristics[j].on('notify', notify);

        characteristics[j].on('descriptorsDiscover', descriptorsDiscover);

        discoveredCharacteristics.push({
          uuid: characteristics[j].uuid,
          properties: characteristics[j].properties
        });
      }

      sendEvent(contextId, {
        type: 'characteristicsDiscover',
        peripheralUuid: peripheral.uuid,
        serviceUuid: service.uuid,
        characteristics: discoveredCharacteristics
      });
    })
    service.discoverCharacteristics(characteristicUuids);
  } else if (action === 'read') {

    peripheral.once('handleRead', function (handle, data) {
      sendEvent(contextId, {
        type: 'handleRead',
        peripheralUuid: this.uuid,
        handle: handle,
        data: data.toString('hex')
      });
    });
    characteristic.read();
  } else if (action === 'write') {

    let fnHandleWrite;
    peripheral.once('handleWrite', fnHandleWrite = function (handle) {
      sendEvent(contextId, {
        type: 'handleWrite',
        peripheralUuid: this.uuid,
        handle: handle
      });
    });
    characteristic.once('write', () => {

      sendEvent(contextId, {
        type: 'write',
        peripheralUuid: peripheral.uuid,
        serviceUuid: service.uuid,
        characteristicUuid: characteristic.uuid
      });
      peripheral.off('handleWrite', fnHandleWrite);
    });
    characteristic.write(data, withoutResponse);
  } else if (action === 'broadcast') {
    characteristic.broadcast(broadcast);
  } else if (action === 'notify') {

    peripheral.once('handleNotify', function (handle, data) {
      sendEvent(contextId, {
        type: 'handleNotify',
        peripheralUuid: this.uuid,
        handle: handle,
        data: data.toString('hex')
      });
    });

    if(characteristic) {
      characteristic.notify(notify);
    } else {
      // errr... you get to time out, mr. command!
      // in my experience, this occurs if HCI/etc screwed the pooch while trying to enumerate services, and then
      // the calling app tries to stopNotifications on a stale characteristic
      console.log(`Errr, you tried to notify on a characteristic ${characteristicUuid} on peripheral ${peripheralUuid} we don't think exists`, command);
      debugger;
    }
  } else if (action === 'discoverDescriptors') {
    characteristic.discoverDescriptors();
  } else if (action === 'readValue') {
    descriptor.readValue();
  } else if (action === 'writeValue') {
    descriptor.writeValue(data);
  } else if (action === 'readHandle') {
    peripheral.readHandle(handle);
  } else if (action === 'writeHandle') {
    peripheral.writeHandle(handle, data, withoutResponse);
  }
};

function wipeOldListeners(peripheral, andThisToo) {
  //console.log("wiping listeners from " + peripheral.uuid + " / " + peripheral.contextId + " / " + andThisToo);
  for (var i in peripheral.services) {
    for (var j in peripheral.services[i].characteristics) {
      for (var k in peripheral.services[i].characteristics[j].descriptors) {
        peripheral.services[i].characteristics[j].descriptors[k].removeAllListeners();
      }

      peripheral.services[i].characteristics[j].removeAllListeners();
    }
    peripheral.services[i].removeAllListeners();
  }

  if(andThisToo) {
    peripheral.removeAllListeners();
  }
  //console.log("wiped listeners from " + peripheral.uuid + " / " + andThisToo);
}


noble.on('discover', function (peripheral) {

  handleDiscoveredPeripheral(peripheral);
});