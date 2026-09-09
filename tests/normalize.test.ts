import { describe, expect, it } from 'vitest';
import {
  normalizeDateOfBirth,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeSex,
  normalizeState,
  normalizeZip,
  speakDate,
  speakPhone,
} from '../src/domain/normalize';

/**
 * Unit tests for the speech-to-data layer. These are the functions that decide
 * whether a caller saying "my ZIP is nine four one oh seven" ends up as a valid
 * record, so they carry the bulk of the edge-case coverage.
 */

describe('normalizePhone', () => {
  it('accepts the formats a caller or an LLM might produce', () => {
    for (const input of ['4155550123', '(415) 555-0123', '415-555-0123', '+1 415 555 0123', '1-415-555-0123']) {
      expect(normalizePhone(input)).toBe('4155550123');
    }
  });

  it('rejects a too-short number (the assessment\'s 3-digit example)', () => {
    expect(normalizePhone('555')).toBeNull();
    expect(normalizePhone('415555012')).toBeNull();
  });

  it('rejects numbers that are not valid under NANP rules', () => {
    expect(normalizePhone('1111111111')).toBeNull(); // exchange starts with 1
    expect(normalizePhone('0155550123')).toBeNull(); // area code starts with 0
    expect(normalizePhone('4150550123')).toBeNull(); // exchange starts with 0
  });

  it('formats digits for speech', () => {
    expect(speakPhone('4155550123')).toBe('415 555 0123');
  });
});

describe('normalizeDateOfBirth', () => {
  it('accepts MM/DD/YYYY and ISO, normalising to YYYY-MM-DD', () => {
    expect(normalizeDateOfBirth('03/05/1985')).toEqual({ ok: true, value: '1985-03-05' });
    expect(normalizeDateOfBirth('3/5/1985')).toEqual({ ok: true, value: '1985-03-05' });
    expect(normalizeDateOfBirth('1985-03-05')).toEqual({ ok: true, value: '1985-03-05' });
  });

  it('rejects a future date of birth', () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    expect(normalizeDateOfBirth(`01/01/${nextYear}`)).toEqual({ ok: false, reason: 'future' });
  });

  it('rejects dates that do not exist on the calendar', () => {
    expect(normalizeDateOfBirth('02/30/1990')).toEqual({ ok: false, reason: 'invalid_date' });
    expect(normalizeDateOfBirth('13/01/1990')).toEqual({ ok: false, reason: 'invalid_date' });
  });

  it('rejects implausibly old dates and unparseable input', () => {
    expect(normalizeDateOfBirth('01/01/1700')).toEqual({ ok: false, reason: 'too_old' });
    expect(normalizeDateOfBirth('sometime in the eighties')).toEqual({
      ok: false,
      reason: 'unparseable',
    });
  });

  it('reads a stored date back the way it should be spoken', () => {
    expect(speakDate('1985-03-05')).toBe('March 5, 1985');
  });
});

describe('normalizeState', () => {
  it('accepts a spoken full state name', () => {
    expect(normalizeState('California')).toBe('CA');
    expect(normalizeState('new york')).toBe('NY');
    expect(normalizeState('District of Columbia')).toBe('DC');
  });

  it('accepts an abbreviation, including one spelled out letter by letter', () => {
    expect(normalizeState('ca')).toBe('CA');
    expect(normalizeState('C A')).toBe('CA');
  });

  it('rejects anything that is not a U.S. state', () => {
    expect(normalizeState('Ontario')).toBeNull();
    expect(normalizeState('XX')).toBeNull();
  });
});

describe('normalizeZip', () => {
  it('accepts 5-digit and ZIP+4', () => {
    expect(normalizeZip('94107')).toBe('94107');
    expect(normalizeZip('94107-1234')).toBe('94107-1234');
    expect(normalizeZip('941071234')).toBe('94107-1234');
  });

  it('rejects the wrong number of digits', () => {
    expect(normalizeZip('941')).toBeNull();
    expect(normalizeZip('9410712')).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('repairs an address dictated over the phone', () => {
    expect(normalizeEmail('john dot smith at gmail dot com')).toBe('john.smith@gmail.com');
    expect(normalizeEmail('JANE@Example.COM')).toBe('jane@example.com');
  });

  it('rejects malformed addresses', () => {
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('john@localhost')).toBeNull();
  });
});

describe('normalizeSex', () => {
  it('maps natural phrasing onto the four allowed values', () => {
    expect(normalizeSex('male')).toBe('Male');
    expect(normalizeSex('F')).toBe('Female');
    expect(normalizeSex('non-binary')).toBe('Other');
    expect(normalizeSex("I'd prefer not to say")).toBe('Decline to Answer');
  });

  it('returns null for an unrecognised answer so the agent re-prompts', () => {
    expect(normalizeSex('yes')).toBeNull();
  });
});

describe('normalizeName', () => {
  it('titlecases while preserving internal punctuation', () => {
    expect(normalizeName('mary-jane')).toBe('Mary-Jane');
    expect(normalizeName("o'brien")).toBe("O'Brien");
    expect(normalizeName('  JANE   doe ')).toBe('Jane Doe');
  });
});
