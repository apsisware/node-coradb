'use strict';
const { DateTime } = require('luxon');

module.exports = Timezone;

/**
 * Constructor
 * @param datetime
 * @param timezone
 */
function Timezone(datetime, timezone) {
  // The wall-clock time in the value's zone, held in the Date's UTC fields
  // (as the server sends it). The instant it stands for is `valueOf()`.
  this.datetime = datetime;

  if (timezone) {
    this.timezone = timezone.toString();
    const tz = this.timezone.split(' ');
    this.region = tz[0];

    // The abbreviation the server sent tells the two readings of a repeated
    // hour apart (see _zoned).
    const zoned = _zoned(this.datetime, this.region, tz[1]);

    if (!tz[1]) {
      // derive the zone abbreviation from the region
      this.tzd = zoned ? zoned.offsetNameShort : '';
    } else {
      this.tzd = tz[1];
    }

    // Format the UTC offset for this instant as '+HH:MM' / '-HH:MM',
    // matching the previous moment `.format('Z')` output. The offset is the
    // one in force at this wall-clock time in the zone: it used to be taken
    // at the instant the wall-clock time names in UTC, which is hours away
    // and can be on the other side of a DST change.
    const timeOffset = zoned ? _formatOffset(zoned.offset).split(':') : ['', ''];
    this.tzh = timeOffset[0];
    this.tzm = timeOffset[1];
  } else {
    this.timezone = '';
    this.tzd = '';
    this.tzh = '';
    this.tzm = '';
  }
}

/**
 * Returns 'YYYY-MM-DD HH24:MI:SS TIMEZONE' format
 * @returns {string}
 */
Timezone.prototype.toString = function () {
  return `${this.format('YYYY-MM-DD HH24:MI:SS.FF')}${(this.timezone ? ` ${this.timezone}` : ``)}`;
};

/**
 * This format based Date/Time format from http://www.coradb.ai/manual/sql/function/typecast_fn.html#to-char-date-time
 * @param format
 * @returns {String}
 */
Timezone.prototype.format = function (format) {
  if (!this.datetime) return '';

  const daysofweek = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday'];
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'];
  const date = this.datetime;
  const that = this;

  let am = (/AM|A\.M\./i).exec(format);
  let pm = (/PM|P\.M\./i).exec(format);
  if (am) {
    am = am[0];
    const code = am.codePointAt(0) + 15;
    pm = am.replace(/A/i, String.fromCharCode(code));
  } else if (pm) {
    pm = pm[0];
    const code = pm.codePointAt(0) - 15;
    am = pm.replace(/P/i, String.fromCharCode(code));
  }

  format = format.toUpperCase();
  const formatRex = /CC|YYYY|YY|Q|MM|MONTH|MON|DD|DAY|DY|D|d|AM|PM|A\.M\.|P\.M\.|HH12|HH24|HH|MI|SS|FF|TZD|TZH|TZM/g;

  return format.replace(formatRex, function ($1) {
    switch ($1) {
      case 'CC':
        return Math.floor(Number.parseInt(date.getUTCFullYear() / 100)) + 1;
      case 'YYYY':
        return date.getUTCFullYear();
      case 'YY':
        return _zeroPadding(date.getUTCFullYear() % 100);
      // The month in UTC too, like every other field: the local month read
      // a January 31st as February in a zone east of UTC ('2026-02-31').
      case 'Q': {
        const mon = date.getUTCMonth();
        if (mon < 3) return 1;
        else if (mon < 6) return 2;
        else if (mon < 9) return 3;
        else return 4;
      } case 'MM':
        return _zeroPadding(date.getUTCMonth() + 1);
      case 'MONTH':
        return months[date.getUTCMonth()];
      case 'MON':
        return months[date.getUTCMonth()].slice(0, 3);
      case 'DD':
        return _zeroPadding(date.getUTCDate());
      case 'DAY':
        return daysofweek[date.getUTCDay()];
      case 'DY':
        return daysofweek[date.getUTCDay()].slice(0, 3);
      case 'D':
      case 'd':
        return (date.getUTCDay() === 0) ? 7 : date.getUTCDay();
      case 'AM':
      case 'A.M.':
      case 'PM':
      case 'P.M.':
        return (date.getUTCHours() < 12) ? am : pm;
      case 'HH':
      case 'HH12': {
        // 1 to 12: midnight is 12 AM, as noon is 12 PM (it was 00).
        const hour = date.getUTCHours() % 12;
        return _zeroPadding(hour || 12);
      } case 'HH24':
        return _zeroPadding(date.getUTCHours());
      case 'MI':
        return _zeroPadding(date.getUTCMinutes());
      case 'SS':
        return _zeroPadding(date.getUTCSeconds());
      case 'FF':
        return _zeroPadding(date.getUTCMilliseconds(), true);
      case 'TZD':
        return that.tzd;
      case 'TZH':
        return that.tzh;
      case 'TZM':
        return that.tzm;
      default:
        return $1;
    }
  });
};

/**
 * Return the number of milliseconds between 1 January 1970 00:00:00 UTC and Timezone.datetime
 * @returns {Number}
 */
Timezone.prototype.valueOf = function () {
  // The wall-clock time read in its zone. It used to be read as UTC, which
  // put every value off by its zone's offset. A zone luxon does not know
  // keeps that reading, for want of a better one.
  const zoned = this.region ? _zoned(this.datetime, this.region, this.tzd) : null;

  return zoned ? zoned.toMillis() : Date.prototype.valueOf.call(this.datetime);
};

/**
 * Return the number of offset for this timezone, in milliseconds.
 * Uses the same sign convention as the previous moment implementation
 * (minutes to add to local time to reach UTC, expressed in ms).
 * @returns {Number}
 */
Timezone.prototype.getOffset = function () {
  const zoned = _zoned(this.datetime, this.region, this.tzd);
  const offsetMinutes = zoned ? zoned.offset : 0;
  return -offsetMinutes * 60 * 1000;
};

/**
 * The value as a luxon DateTime in its zone: the wall-clock fields (the
 * Date's UTC fields) placed in `region`. A region written as an offset
 * ('+09:00') is read as one. Null when the zone or the date is not usable.
 *
 * A wall-clock time in the hour repeated when daylight saving time ends
 * (01:30 on 2017-11-05 in America/New_York) names two instants. luxon picks
 * one; the server says which with the abbreviation it sends (EDT, not EST).
 * That reading is taken when `abbreviation` matches one of them — by name, as
 * some English locale writes it (EDT, CEST, BST, AEDT), or as an offset
 * ('-02', '+0530'). Otherwise luxon's stands. It used to stand always, so a
 * value the server sent as EDT came back as EST, an hour late.
 * @param date
 * @param region
 * @param abbreviation the zone abbreviation the server sent, if any
 * @returns {DateTime|null}
 */
function _zoned(date, region, abbreviation) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || !region) {
    return null;
  }

  const zone = /^[+-]\d{1,2}(:\d{2})?$/.test(region) ? `UTC${region}` : region;
  const zoned = DateTime.fromObject({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  }, { zone });

  if (!zoned.isValid) {
    return null;
  }

  return abbreviation ? _readingNamed(zoned, abbreviation) : zoned;
}

// English locales whose short zone names, between them, include the
// abbreviations of North America, Europe and Australia; others write GMT+n.
const ABBREVIATION_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IE', 'en-NZ', 'en-IN'];

// An abbreviation that is an offset, as the tz database writes many: '-03', '+0530'.
const OFFSET_ABBREVIATION = /^([+-])(\d{2})(\d{2})?$/;

/**
 * Of the instants a wall-clock time can name in its zone (two in a repeated
 * hour, one otherwise), the one `abbreviation` names; `zoned` itself when
 * there is no choice or none matches.
 * @param zoned
 * @param abbreviation
 * @returns {DateTime}
 */
function _readingNamed(zoned, abbreviation) {
  const readings = typeof zoned.getPossibleOffsets === 'function' ? zoned.getPossibleOffsets() : [];

  if (readings.length < 2) {
    return zoned;
  }

  const m = OFFSET_ABBREVIATION.exec(abbreviation);

  if (m) {
    const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));

    return readings.find((r) => r.offset === minutes) || zoned;
  }

  const named = readings.find((r) => ABBREVIATION_LOCALES.some((locale) => r.setLocale(locale).offsetNameShort === abbreviation));

  return named ? named.setLocale(zoned.locale) : zoned;
}

/**
 * Format a UTC offset given in minutes as '+HH:MM' / '-HH:MM'.
 * @param offsetMinutes
 * @returns {String}
 */
function _formatOffset(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = _zeroPadding(Math.floor(abs / 60));
  const minutes = _zeroPadding(abs % 60);
  return `${sign}${hours}:${minutes}`;
}

function _zeroPadding(value, isMs) {
  let data;
  if (value < 10) {
    data = `0${value}`;
  } else {
    data = value;
  }

  if (isMs) {
    if (value < 100) {
      data = `0${data}`
    }
  }

  return data;
}