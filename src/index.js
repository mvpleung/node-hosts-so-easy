import fs from 'fs';

import atomicWrite from 'atomic-write';
import debounce from 'lodash/debounce';
import EventEmitter from 'eventemitter3';

const win = process.env === 'win32';
/* istanbul ignore next */
const DEFAULT_EOL = win ? '\r\n' : '\n';
/* istanbul ignore next */
const DEFAULT_HOSTS = win ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/hosts';

/* istanbul ignore next */
const isArray = Array.isArray ||
  (arg => Object.prototype.toString.call(arg) === '[object Array]');

function arrayJoinFunc(arr, separatorFunc) {
  return arr.map(
    (el, i) => el + (i < arr.length-1 ? separatorFunc(el, i) : '')
  ).join('');
}

function noop() {}
function ifErrThrow(err) {
  /* istanbul ignore next */
  if (err)
    throw err;
}

class Hosts extends EventEmitter {

  /* --- PUBLIC API --- */

  constructor(options) {
    super();

    this.writeInProgress = false;
    this.queue = { add: {}, remove: {}, removeHost: {} };
    this.hostsFile = {};

    const config = this.config = {
      atomicWrites: true,
      debounceTime: 500,
      hostsFile: DEFAULT_HOSTS,
      noWrites: false,
      EOL:  DEFAULT_EOL,
    };

    if (options) {
      for (const key in options) {
        if (typeof config[key] !== 'undefined')
          config[key] = options[key];
        else
          throw new Error("No such config option: " + key);
      }
    }

    this._writeFile = config.atomicWrites
      ? atomicWrite.writeFile.bind(atomicWrite)
      : fs.writeFile.bind(fs);

    this._queueUpdate = config.noWrites
      ? noop
      : debounce(this._update.bind(this, ifErrThrow), config.debounceTime);
  }

  add(ip, host) {
    const queue = this.queue;

    if (!queue.add[ip])
      queue.add[ip] = [];

    if (typeof host === 'string')
      queue.add[ip].push(host);
    else if (isArray(host))
      queue.add[ip] = queue.add[ip].concat(host);
    else
      throw new Error('hosts.add(ip, host) expects `host` to be a string or array of ' +
        `strings, not ${typeof host}: ` + JSON.stringify(host));

    this._queueUpdate();
  }

  remove(ip, host) {
    const queue = this.queue;

    if (!queue.remove[ip])
      queue.remove[ip] = [];

    // Don't do anything if there is already a '*' for this host in the queue
    if (queue.remove[ip] === '*')
      return;

    if (host === '*')
      queue.remove[ip] = '*';
    else if (typeof host === 'string')
      queue.remove[ip].push(host);
    else if (isArray(host))
      queue.remove[ip] = queue.remove[ip].concat(host);
    else
      throw new Error('hosts.remove(ip, host) expects `host` to be a string or array of ' +
        `strings, not ${typeof host}: ` + JSON.stringify(host));

    this._queueUpdate();
  }

  removeHost(host) {
    this.queue.removeHost[host] = true;
    this._queueUpdate();
  }

  clearQueue() {
    this.queue.add = {};
    this.queue.remove = {};
    this.queue.removeHost = {};
  }

  postWrite(callback) {
    // Ok for now, could handle reject/err with a bit more effort.

    if (callback)
      this.once('writeSuccess', callback);
    else
      return new Promise(resolve => {
        this.once('writeSuccess', resolve);
      });
  }

  /* --- INTERNAL API --- */

  modify(input) {
    const queue = this.queue;
    const arr = input.split(/\r?\n/).map(line => {
      if (line === '' || line.startsWith('#'))
        return line;

      let hosts = line.split(/[\s]+/);
      const ip = hosts.shift();

      // Null only on invalid /etc/hosts (e.g. IP with no hostname), but let's still run.
      let whitespace = line.match(/\s+/g);
      whitespace = whitespace ? whitespace.slice() : [];

      // removeHost
      hosts = hosts.filter(x => !queue.removeHost[x]);
      queue.removeHost = {};

      if (queue.add[ip]) {
        hosts = hosts.concat(queue.add[ip].filter(x => !hosts.includes(x)));
        delete queue.add[ip];
      }

      if (queue.remove[ip]) {
        if (queue.remove[ip] === '*') {
          hosts = [];
        } else {
          let host;
          while ((host = queue.remove[ip].pop()))
            hosts = hosts.filter(x => x !== host)
        }
      }

      if (hosts.length)
        return ip +
          (whitespace[0] || ' ') +
          arrayJoinFunc(hosts, (x, i) => whitespace[i+1] || ' ');

      return undefined;
    });

    // Start before trailing newlines and comments
    let startIndex;
    if (arr[0] === '') {
      arr.pop();
      startIndex = 0;
    } else {
      startIndex = arr.length - 1;
      while (startIndex > 0 && (!arr[startIndex] || arr[startIndex].startsWith('#')))
        startIndex--;
    }

    // TODO: try mimic preceeding whitespace pattern?
    for (const ip in queue.add)
      arr.splice(++startIndex, 0, ip + ' ' + queue.add[ip].join(' '));

    this.clearQueue();

    return arr.join(this.config.EOL);
  }

  /* --- FILE MANAGEMENT (INTERNAL) --- */

  _updateContents(contents) {
    this._writeFile(this.config.hostsFile, contents, err => {
      if (err)
        throw err;
      this.writeInProgress = false;
      this.emit('writeSuccess');
    });
  }

  // note: callback is only currently used for testing
  _update(callback) {
    if (this.writeInProgress)
      return this._queueUpdate();

    this.writeInProgress = true;
    this.emit('writeStart');

    // Check if file has changed to avoid unnecessary reread.
    // TODO don't check if we've written since last read.
    fs.stat(this.config.hostsFile, (err, stats) => {
      if (err)
        return callback(err);

      if (this.hostsFile.ctime && this.hostsFile.ctime.getTime() === stats.ctime.getTime()) {

        this._updateContents(this.modify(this.hostsFile.raw));
        callback();

      } else {

        this.hostsFile.ctime = stats.ctime;
        fs.readFile(this.config.hostsFile, (err, file) => {
          if (err)
            return callback(err);

          this.hostsFile.raw = file.toString();
          this._updateContents(this.modify(this.hostsFile.raw));
          callback();
        });

      }
    });
  }

}

export { noop };
export default Hosts;
