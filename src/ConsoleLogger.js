// Severity ranking used by the minimum-level filter. Lower numbers are more
// verbose; a message is emitted only when its level is at or above the
// configured threshold.
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL = 'debug';

/**
 * A simple logger that writes to the console.
 *
 * @param level (optional) the minimum level to emit: one of 'debug', 'info',
 *   'warn', 'error'. Messages below this level are suppressed. Defaults to
 *   'debug' (emit everything). An unknown value falls back to the default.
 * @constructor
 */
function ConsoleLogger(level) {
  const threshold = LEVELS[level];

  this._minLevel = typeof threshold === 'number' ? threshold : LEVELS[DEFAULT_LEVEL];
}

ConsoleLogger.prototype._isEnabled = function (level) {
  return LEVELS[level] >= this._minLevel;
};

ConsoleLogger.prototype.error = function () {
  if (this._isEnabled('error')) {
    console.error(...arguments);
  }
};

ConsoleLogger.prototype.info = function () {
  if (this._isEnabled('info')) {
    console.info(...arguments);
  }
};

ConsoleLogger.prototype.warn = function () {
  if (this._isEnabled('warn')) {
    console.warn(...arguments);
  }
};

ConsoleLogger.prototype.debug = function () {
  if (this._isEnabled('debug')) {
    console.log(...arguments);
  }
};

module.exports = ConsoleLogger;
