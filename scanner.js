// scanner: this guy continuously scans for new bluetooth things to connect to.
//          why? near as I can tell, a single process can't use bluetooth-hci-socket to scan AND communicate at the same time
//          but I can make another process that just scans continuously, and sends the intel over to the ws-slave process.
//          then when a connected context asks ws-slave to scan, ws-slave will just start forwarding all the stuff that this
//          process is digging up.


var noble = require('./index');
var WebSocket = require('ws');

var g_scanSocket;

noble.on('discover', function (peripheral) {

  if(g_scanSocket) {
    console.log("sending info about ", peripheral.advertisement.localName);

    const myCopy = Object.assign({}, peripheral);
    delete myCopy._noble;
    g_scanSocket.send(JSON.stringify({
      evt: 'discover',
      data: myCopy,
    }));
  }
});


noble.on('stateChange', (state) => {
  if(state === 'poweredOn') {

    // start our websocket connection to the ws-slave process
    const scanPort = 0xb1d;
    const scanSocket = new WebSocket(`ws://localhost:${scanPort}`);
    scanSocket.on('open', () => {
      g_scanSocket = scanSocket;
    });
    scanSocket.on('close', () => {
      // oh uh, we lost our host process
      console.log("Scanner: host process lost");
      process.exit(0);
    })

    function doScanCycle() {
      console.log("cycle");
      noble.startScanning();
      setTimeout(() => {
        noble.stopScanning(() => {
          doScanCycle();
        })
      }, 7500);
    }
    doScanCycle();
      
  }
})