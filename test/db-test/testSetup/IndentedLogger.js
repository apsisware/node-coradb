'use strict';

const path = require('node:path');
const util = require('node:util');
const ConsoleLogger = require(path.resolve(__dirname, '..', '..', '..', 'src', 'ConsoleLogger'));

// ANSI foreground colors applied per log level (only when writing to a TTY,
// so piped/CI output does not get escape-code noise).
const LEVEL_COLORS = {
  debug: 33, // yellow
  error: 31, // red
};

function colorize(level, text) {
  const code = LEVEL_COLORS[level];
  // `error`/`warn` go to stderr (via ConsoleLogger); everything else to stdout.
  const stream = (level === 'error' || level === 'warn') ? process.stderr : process.stdout;
  if (!code || !stream.isTTY) {
    return text;
  }
  return '\x1b[' + code + 'm' + text + '\x1b[0m';
}

/**
 * A test-only logger that prefixes every line with a fixed indent so the
 * driver's `debug`/`info`/`warn`/`error` output (and any test messages routed
 * through it) line up under Mocha's `spec` reporter output. Delegates the
 * actual writing to `ConsoleLogger`.
 *
 * @param indent leading whitespace to prepend (default: 8 spaces)
 * @constructor
 */
function IndentedLogger(indent) {
  this._indent = typeof indent === 'string' ? indent : '        ';
  this._inner = new ConsoleLogger();
}

['error', 'warn', 'info', 'debug'].forEach(function (level) {
  IndentedLogger.prototype[level] = function () {
    const args = Array.prototype.slice.call(arguments);

    // Combine every argument into a single string exactly like `console.*`
    // would (so array/object arguments are fully expanded), then indent EVERY
    // line - including the multi-line expansion of those arguments.
    let text = util.format.apply(util, args);
    text = this._indent + text.replaceAll('\n', '\n' + this._indent);

    // Colorize the whole message per level (e.g. debug -> yellow, error -> red)
    // when writing to a TTY, regardless of the argument types.
    text = colorize(level, text);

    this._inner[level](text);
  };
});

module.exports = IndentedLogger;
