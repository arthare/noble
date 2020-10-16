// scanner: this guy continuously scans for new bluetooth things to connect to.
//          why? near as I can tell, a single process can't use bluetooth-hci-socket to scan AND communicate at the same time
//          but I can make another process that just scans continuously, and sends the intel over to the ws-slave process.
//          then when a connected context asks ws-slave to scan, ws-slave will just start forwarding all the stuff that this
//          process is digging up.


var noble = require('./index');
var express = require('express');

var g_scanSocket;
let g_fMoreScanningRequested = true;

let recentlySeen = {};


noble.on('discover', function (peripheral) {

  
  if(!peripheral || 
     !peripheral.advertisement ||
     !peripheral.advertisement.localName) {
    return;
  }
  const myCopy = Object.assign({}, peripheral);
  delete myCopy._noble;
  const key = peripheral.advertisement.localName;
  console.log("saw ", key);
  
  const tmNow = new Date().getTime();
  recentlySeen[key] = {
    tmNow,
    peripheral: myCopy,
    rssi: myCopy.rssi,
  }
  

  const keysToKill = [];
  for(var keyToCheck in recentlySeen) {
    if(recentlySeen[keyToCheck].tmNow < tmNow - 120000) {
      keysToKill.push(keyToCheck);
    }
  }
  keysToKill.forEach((keyToKill) => delete recentlySeen[keyToKill]);

});

function doScanCycle() {
  console.log("telling noble to do scan cycle");
  noble.startScanning(["1818"], true, (err) => {
    setTimeout(() => {
      noble.stopScanning();
      doScanCycle();
    }, 120000);
  });
}

noble.on('stateChange', (state) => {
  console.log("scanproc: statechange: ", state);
  if(state === 'poweredOn') {
    doScanCycle();
  }
})

const app = express();

app.get('/address', (req, res) => {
  if(req.query && req.query.name) {
    const name = req.query.name;
    const obj = recentlySeen[name];

    if(obj) {
      res.writeHead(200, 'ok');
      res.write(JSON.stringify(obj));
      res.end();
      return;
    }
  }
  res.writeHead(404, 'not found');
  res.write('{}');
  res.end();
});
app.get('/addresses', (req, res) => {

  let ret = {};
  for(var key in recentlySeen) {
    const addr = recentlySeen[key];
    ret[key] = {
      name: key,
      tmLastSeen: addr.tmNow,
      rssi: addr.rssi,
      id: addr.id,
      uuid: addr.uuid,
      address: addr.address,
      addressType: addr.addressType,
    }
  }
  res.writeHead(200, 'ok');
  res.write(JSON.stringify(ret));
  res.end();
})
app.listen(62703);
console.log("scanner serving on localhost:2703/address?name=1234");