/*!
 * libnmap
 * Copyright(c) 2013-2018 Jason Gerfen <jason.gerfen@gmail.com>
 * License: MIT
 */

'use strict'


// Init some support modules
const fs = require('fs');
const os = require('os');
const async = require('async');
const hasbin = require('hasbin');
const ip = require('ip-address');
const xml2js = require('xml2js');
const cidrjs = require('cidr-js');
const merge = require('deepmerge');
const caller = require('caller-id');
const netmask = require('netmask').Netmask;
const proc = require('child_process').exec;
const v6 = ip.Address6;
const cidr = new cidrjs();


/**
 * @function nmap
 * The libnmap robot
 * 
 * @param {Object} options - Optional object of default overrides
 * @param {Function} fn - Callback function providing errors and reports
 */
const nmap = function(options, fn) {


  /**
   * @object defaults
   * Default set of options
   *
   * @param {String} nmap - Path to NMAP binary
   * @param {Boolean} verbose - Turn on verbosity during scan(s)
   * @param {String} ports - Range of ports to scan
   * @param {Array} range - An array of hostnames/ipv4/ipv6, CIDR or ranges
   * @param {Number} timeout - Number of seconds to wait for host/port response
   * @param {Number} blocksize - Number of hosts per network scanning block
   * @param {Number} threshold - Max number of  spawned process
   * @param {Array} flags - Array of flags for .spawn()
   * @param {Boolean} udp - Perform a scan using the UDP protocol
   * @param {Boolean} json - JSON object as output, false produces XML
   */
  const defaults = {
    nmap:       'nmap',
    verbose:    false,
    ports:      '1-1024',
    range: [],
    timeout:    120,
    blocksize:  16,
    threshold:  os.cpus().length * 4,
    flags: [
      '-T4',    // Scan optimization
    ],
    udp:        false,
    json:       true
  };

  /**
   * @method config
   * Configuration object
   */
  const config = {

    /**
     * @function init
     * @scope private
     * Merges supplied options & builds functions
     *
     * @param {Object} defaults libnmap default options
     * @param {Object} opts User supplied configuration object
     * @param {Function} cb Callback
     *
     * @returns {Object}
     */
    init(defaults, opts, cb) {
      const ranges = [];
      let funcs = [];
      const called = caller.getData().functionName;

      /* Override 'defaults.flags' array with 'opts.flags' (prevents merge) */
      if (/array/.test(typeof opts.flags))
          defaults.flags = opts.flags;

      opts = tools.merge(defaults, opts);
      opts.called = called;

      /* Ensure we can always parse the report */
      if (opts.flags.indexOf('-oX -') === -1)
        opts.flags.push('-oX -');

      validation.init(opts, (err, result) => {
        if (err)
          return cb(err);

        if (/discover/.test(called)) {
          if (!(opts.range = tools.adapters(opts)))
            return cb(new Error(validation.verErr));

          /* Set scan options as static values for 'discover' mode */
          opts.ports = '';
          opts.flags = [
            '-n',
            '-oX -',
            '-sn',
            '-PR'
          ];
        }

        opts.range = network.calculate(opts);
        funcs = tools.funcs(opts);

        return cb(null, {
          opts,
          funcs
        });
      });
    }
  };


  /**
   * @method reporting
   * Reporting object
   */
  const reporting = {

    /**
     * @function reports
     * Handle results
     *
     * @param {Obect} opts Application defaults
     * @param {Function} cb Return function
     *
     * @returns {Function}
     */
    reports(opts, report, cb) {
      if ((!/object/.test(typeof report)) || (report.hasOwnProperty('code')))
        return cb(new Error(report));

      const xml = report.join('');

      if (!opts.json)
        return cb(null, xml);

      try {
        const parserOptions = {
          attrkey: "item",
        };

        const xmlParser = new xml2js.Parser(parserOptions);

        xmlParser.parseString(xml, function parseXML(err, json) {
          if(err)
            return cb(new Error(err));

          return cb(null, json.nmaprun);
        });
      } catch(err) {
        return cb(new Error(err));
      }
    }
  };


  /**
   * @method tools
   * Tools object
   */
  const tools = {

    /**
     * @function merge
     * Perform preliminary option/default object merge
     *
     * @param {Object} defaults Application defaults
     * @param {Object} obj User supplied object
     *
     * @returns {Object}
     */
    merge(defaults, obj) {
      return merge(defaults, obj);
    },

    /**
     * @function chunk
     * Defines new property for array's
     * 
     * @param {Array} obj Supplied array
     * @param {Integer} offset Supplied offset
     * 
     * @returns {Array}
     */
    chunk(obj, offset) {
      let idx = 0;
      const alength = obj.length;
      const tarray = [];

      for (idx = 0; idx < alength; idx += offset) {
        tarray.push(obj.slice(idx, idx + offset).join(' '));
      }

      return tarray;
    },

    /**
     * @function flatten
     * Flattens nested arrays into one flat array
     * 
     * @param {Array} arr Array combinator
     * @param {Array} obj User supplied array
     * 
     * @returns {Array}
     */
    flatten(arr, obj) {
      let value;
      const result = [];

      for (let i = 0, length = arr.length; i < length; i++) {

        value = arr[i];

        if (Array.isArray(value)) {
          return this.flatten(value, obj);
        } else {
          result.push(value);
        }
      }
      return result;
    },

    /**
     * @function adapters
     * Obtain network adapter information and return an array of
     *           ranges as an array for CIDR calculations
     *
     * @param {Object} obj User supplied object
     *
     * @returns {Array}
     */
    adapters(obj) {
      const ret = [];
      let adapter = '';
      let subnet = '';
      const adapters = os.networkInterfaces();

      for (const iface in adapters) {

        for (const dev in adapters[iface]) {
          adapter = adapters[iface][dev];

          if (!adapter.internal) {

            if (!adapter.netmask)
              return false;

            if (adapter.netmask) {

              subnet = adapter.netmask;

              if (validation.test(validation.net.IPv6, subnet)) {

                /* Convert netmask to CIDR notation if IPv6 */
                subnet = new v6(netmask).subnet.substring(1);
              } else {

                /* Convert netmask to CIDR */
                subnet = new netmask(`${adapter.address}/${subnet}`);
                adapter.address = subnet.base;
                subnet = subnet.bitmask;
              }

              ret.push(`${adapter.address}/${subnet}`);
            }
          }
        }
      }

      return ret;
    },

    /**
     * @function funcs
     * Create functions for use as callbacks
     *
     * @param {Obect} opts Application defaults
     *
     * @returns {Array}
     */
    funcs(opts) {
      const funcs = {};
      let cmd = false;
      const errors = [];
      const reports = [];

      if (opts.range.length <= 0)
        return new Error("Range of hosts could not be created");

      Object.keys(opts.range).forEach(function blocks(block) {

        const range = opts.range[block];
        funcs[range] = function block(callback) {
          cmd = tools.command(opts, range);

          if (opts.verbose)
            console.log(`Running: ${cmd}`);

          const report = [];

          const execute = proc(cmd, function exe(err, stdout, stderr) {
              if (err)
                return reporting.reports(opts, err, callback);
            });

          execute.stderr.on('data', function errbytes(chunk) {
            /* Silently discard stderr messages to not interupt scans */
          });

          execute.stdout.on('data', function bytes(chunk) {
            report.push(chunk);
          });

          execute.stdout.on('end', function bytesend() {
            if (report.length > 0)
              return reporting.reports(opts, report, callback);
          });
        };
      });

      return funcs;
    },

    /**
     * @function command
     * Generate nmap command string
     *
     * @param {Object} opts - User supplied options
     * @param {String} block - Network block
     *
     * @returns {String} NMAP scan string
     */
    command(opts, block) {
      const flags = opts.flags.join(' ');
      const ipv6 = (validation.test(validation.net.IPv6, block)) ? ' -6 ' : ' ';
      const proto = (opts.udp) ? ' -sU' : ' ';
      const to = `--host-timeout=${opts.timeout}s `;

      return (opts.ports) ?
        `${opts.nmap+proto} ${to}${flags}${ipv6}-p${opts.ports} ${block}` :
        `${opts.nmap+proto} ${to}${flags}${ipv6}${block}`;
    },

    /**
     * @function worker
     * Executes object of functions
     *
     * @param {Object} obj User supplied object
     * @param {Function} fn Return function
     */
    worker(obj, fn) {
      async.parallelLimit(obj.funcs, obj.threshold, fn);
    }
  };


  /**
   * @method network
   * Network object
   */
  const network = {

    /**
     * @function range
     * Calculates all possible hosts per CIDR
     *
     * @param {Object} opts Application defaults
     * @param {Object} host - CIDR formatted network range
     *
     * @returns {Array}
     */
    range(opts, host) {
      const blocks = cidr.list(host);
      let splitat = Math.round(blocks.length / opts.blocksize);
      const results = [];
      let tarray = [];

      // Make sure we account for valid subnet ranges
      splitat = (splitat > 256) ? Math.round(splitat / 255) : splitat;

      if (splitat > 1) {

        // Spllit blocks up by offset
        tarray = tools.chunk(blocks, splitat);
        tarray.forEach(block => {
          results.push(block);
        });
      } else {
        results.push(blocks.join(' '));
      }

      return results;
    },

    /**
     * @function calculate
     * Performs calculation on subnet blocks
     *
     * @param {Object} opts Application defaults
     *
     * @returns {Array}
     */
    calculate(opts) {
      const blocks = [];
      let results = [];
      const tresults = [];
      const tests = validation.net;

      opts.range.forEach(host => {

        switch (true) {

          /* singular IPv4, IPv6 or RFC-1123 hostname */
          case (validation.test(tests.hostname, host) ||
                validation.test(tests.IPv4, host) ||
                validation.test(tests.IPv6, host)):

            results.push(host);

            break;

          /* IPv4 CIDR notation; break up into chunks for parallel processing */
          case (validation.test(tests.IPv4CIDR, host)):

            tresults.push(network.range(opts, host));

            break;

          /* IPv4 range notation */
          case (validation.test(tests.IPv4Range, host)):

            results.push(host);

            break;

          case (validation.test(tests.IPv6CIDR, host)):
            
            /* Add IPv6 calculations to assist with parallel processing */
            results.push(host);

            break;

          default:

            /* Silently discard specified element as invalid */
            break;
        }
      });

      if (tresults.length > 0) {
        results = tools.merge(results, tresults[0])
      }

      return results;
    }
  };


  /**
   * @method validation
   * Validation object
   */
  const validation = {

    verErr: 'Discover method requires nodejs v0.11.2 or greater',

    pathErr: 'Supplied path for nmap binary is invalid',

    blockErr: 'Supplied blocksize must not exceed 128',

    rangeErr: 'Range must be an array of host(s). Examples: ' +
      '192.168.2.10 (single), 10.0.2.0/24 (CIDR), 10.0.10.5-20 (range)',

    portErr: 'Port(s) must match one of the following examples: ' +
      '512 (single) | 0-65535 (range) | 10-30,80,443,3306-10000 (multiple)',

    /**
     * @var net
     * Object with various REGEX patterns to validate network params
     */
    net: {

      /**
       * @var ports
       * Regex for matching port ranges
       * @ref http://stackoverflow.com/a/21075138/901697
       */
      ports: /^(?:(?:^|[-,])(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6(?:[0-4][0-9]{3}|5(?:[0-4][0-9]{2}|5(?:[0-2][0-9]|3[0-5])))))+$/,

      /**
       * @var hostname
       * Regex for matching hostnames (RFC-1123)
       */
      hostname: /^(([a-zA-Z]|[a-zA-Z][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z]|[A-Za-z][A-Za-z0-9\-]*[A-Za-z0-9])|localhost$/,

      /**
       * @var IPv4
       * Regex for matching IPv4 address types
       */
      IPv4: /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/,

      /**
       * @var IPv4CIDR
       * Regex for matching IPv4 CIDR notation
       */
      IPv4CIDR: /(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(\/([1-2]\d|3[0-2]|\d))/,

      /**
       * @var IPv4Range
       * Regex for matching IPv4 Range notation
       */
      IPv4Range: /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\-([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/,

      /**
       * @var IPv6
       * Regex for matching IPv6 address types
       */
      IPv6: /^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*/,

      /**
       * @var IPv6CIDR
       * Regex for matching IPv6 CIDR notation
       */
      IPv6CIDR: /^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*(\/(\d|\d\d|1[0-1]\d|12[0-8]))$/,
    },

    /**
     * @function init
     * Construct for network/port validation
     *
     * @param {Object} opts - User supplied options
     * @param {Function} cb - Callback
     */
    init(opts, cb) {
      const scope = this;
      const errors = [];

      scope.exists(opts.nmap, function exists(result) {
        if (!result) {

          // Try full path vs. process.env.PATH
          fs.access(opts.nmap, fs.constants.F_OK|fs.constants.X_OK, e => {
            if (e)
              cb(errors.push(new Error(scope.pathErr)));
          });
        }
      });

      if (opts.blocksize > 128)
        errors.push(new Error(scope.blockErr));

      if (!/discover/.test(opts.called)) {
        if ((!opts.range) || (!/array|object/.test(typeof(opts.range))) ||
            (opts.range.length === 0))
          errors.push(new Error(scope.rangeErr));

        if (opts.range.length >= 1) {
          opts.range.forEach(value => {
            scope.verify(value, (err, result) => {
              if (err) return errors.push(err);
            });
          });
        }
      }

      if (opts.ports) {
        if (!scope.net.ports.test(opts.ports))
          errors.push(new Error(scope.portErr));
      }

      return (errors.length > 0) ? cb(errors) : cb(null, true);
    },

    /**
     * @function verify
     * Verify options provided
     *
     * @param {String} host User supplied configuration object
     * @param {Function} cb - Callback
     *
     * @returns {Function}
     */
    verify(host, cb) {
      if (this.test(this.net.hostname, host) ||
          this.test(this.net.IPv4, host) ||
          this.test(this.net.IPv6, host) ||
          this.test(this.net.IPv4CIDR, host) ||
          this.test(this.net.IPv6CIDR, host) ||
				  this.test(this.net.IPv4Range, host)) {
        return cb(null, true);
      } else {
        return cb(new Error(`Supplied host (${host}) did not pass validation. ${this.rangeErr}`));
      }
    },

    /**
     * @function test
     * Test specified regex test on string
     *
     * @param {Object} regex - Regex test case
     * @param {String} str - String to perform test on
     *
     * @returns {Boolean}
     */
    test(regex, str) {
      return regex.test(str);
    },

    /**
     * @function exists
     * Binary file tests
     *
     * @param {String} path - Path for file
     *
     * @returns {Boolean}
     */
    exists(path) {
      return hasbin.sync(path);
    },
  };


  /**
   * @function discover
   * Finds online neighbors
   *
   * @param {Object} obj User supplied options
   * @param {Function} cb User supplied callback function
   */
  nmap.prototype.discover = function(obj, cb) {
    cb = cb || obj;

    let opts = {};

    config.init(defaults, obj, function config(err, settings) {
      if (err)
        return cb(err);

      opts = settings.opts;
      opts.funcs = settings.funcs;

      tools.worker(opts, function discover(err, data) {
        if (err)
          return cb(err);

        return cb(null, data);
      });
    });
  };


  /**
   * @function scan
   * Performs scan of specified host/port combination
   *
   * @param {Object} obj User supplied options
   * @param {Function} cb User supplied callback function
   */
  nmap.prototype.scan = function(obj, cb) {
    cb = cb || obj;

    let opts = {};

    config.init(defaults, obj, function config(err, settings) {
      if (err)
        return cb(err);

      opts = settings.opts;
      opts.funcs = settings.funcs;

      tools.worker(opts, function scan(err, data) {
        if (err)
          return cb(err);

        return cb(null, data);
      });
    });
  };
};


/* robot, do work */
module.exports = new nmap();