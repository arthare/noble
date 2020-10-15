var Noble = require('./lib/noble');

if(process.env.debug) {
  console.lag = console.log;
} else {
  console.lag = () => {};
}

function isSlaveProcess() {

  return (!!process.argv.find((arg) => {
    return arg === "out-of-proc" || arg === "use-noble-inproc";
  }));
}

var bindings;
if(isSlaveProcess() || process.argv[1].includes("ws-slave")) {
    bindings = require('./lib/resolve-bindings')();
    module.exports = new Noble(bindings);
} else {
    module.exports = null;
}
