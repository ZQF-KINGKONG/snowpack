const path = require('path');
const fs = require('fs').promises;
const {readdirSync, readFileSync, existsSync} = require('fs');
const execa = require('execa');
const rimraf = require('rimraf');
const dircompare = require('dir-compare');

const KEEP_LOCKFILE = [
  'source-pika-lockfile', // We explicitly want to test the lockfile in this test
];

const SKIP_FILE_CHECK = [
  'config-rollup', // only expected-output.txt is needed for the test, and Windows comparison fails because of backslashes
  'include-ignore-unsupported-files', // no output expected
];

function stripBenchmark(stdout) {
  return stdout.replace(/\s*\[\d+\.?\d+s\](\n?)/g, '$1'); //remove benchmark
}
function stripStats(stdout) {
  // Need to strip leading whitespace to get around strange Node v13 behavior
  return stdout.replace(/\s+[\d\.]*? KB/g, '    XXXX KB');
}
function stripWhitespace(stdout) {
  return stdout.replace(/((\s+$)|((\\r\\n)|(\\n)))/gm, '');
}
function stripRev(code) {
  return code.replace(/\?rev=\w+/gm, '?rev=XXXXXXXXXX');
}
function stripChunkHash(stdout) {
  return stdout.replace(/([\w\-]+\-)[a-z0-9]{8}(\.js)/g, '$1XXXXXXXX$2');
}
function stripUrlHash(stdout) {
  return stdout.replace(/\-[A-Za-z0-9]{20}\//g, 'XXXXXXXX');
}
function stripConfigErrorPath(stdout) {
  return stdout.replace(/^! (.*)package\.json$/gm, '! XXX/package.json');
}
function stripResolveErrorPath(stdout) {
  return stdout.replace(/" via "(.*)"/g, '" via "XXX"');
}
function stripNodeBuiltIn(stdout) {
  return stdout.replace(/"[^"]+"(\s+\(Node.js built-in\))/g, '"XXXX"$1'); // these errors don’t throw in the same order each time, so test quantity, not order
}
function stripStacktrace(stdout) {
  return stdout.replace(/^\s+at\s+.*/gm, ''); // this is OK to show to the user but annoying to have in a test
}
function stripAnsiEscapes(stdout) {
  return stdout.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g,
    '',
  );
}

function removeLockfile(testName) {
  const lockfileLoc = path.join(__dirname, testName, 'snowpack.lock.json');
  try {
    rimraf.sync(lockfileLoc);
  } catch (err) {
    // ignore
  }
}

describe('snowpack install', () => {
  beforeAll(() => {
    // Needed so that ora (spinner) doesn't use platform-specific characters
    process.env = Object.assign(process.env, {CI: '1'});
  });

  for (const testName of readdirSync(__dirname)) {
    if (testName === 'node_modules' || testName.includes('.')) {
      continue;
    }

    // TODO: remove when ora is replaced
    if (testName === 'error-node-builtin-unresolved') {
      continue; // this test is skipped because the ora failure message causes the output to flake depending on Node version + OS
    }

    it(testName, async () => {
      // Cleanup
      if (!KEEP_LOCKFILE.includes(testName)) {
        removeLockfile(testName);
      }

      // Run Test
      const {all} = await execa('npm', ['run', 'testinstall', '--silent'], {
        cwd: path.join(__dirname, testName),
        reject: false,
        all: true,
      });
      // Test Output
      let expectedOutputLoc = path.join(__dirname, testName, 'expected-output.txt');
      if (process.platform === 'win32') {
        const expectedWinOutputLoc = path.resolve(expectedOutputLoc, '../expected-output.win.txt');
        if (existsSync(expectedWinOutputLoc)) {
          expectedOutputLoc = expectedWinOutputLoc;
        }
      }
      const expectedOutput = await fs.readFile(expectedOutputLoc, {encoding: 'utf8'});
      expect(
        stripWhitespace(
          stripConfigErrorPath(
            stripResolveErrorPath(
              stripBenchmark(
                stripChunkHash(
                  stripStats(stripAnsiEscapes(stripStacktrace(stripNodeBuiltIn(all)))),
                ),
              ),
            ),
          ),
        ),
      ).toBe(stripWhitespace(expectedOutput));

      // Test Lockfile (if one exists)
      const expectedLockLoc = path.join(__dirname, testName, 'expected-lock.json');
      const expectedLock = await fs
        .readFile(expectedLockLoc, {encoding: 'utf8'})
        .catch((/* ignore */) => null);
      if (expectedLock) {
        const actualLockLoc = path.join(__dirname, testName, 'snowpack.lock.json');
        const actualLock = await fs.readFile(actualLockLoc, {encoding: 'utf8'});
        if (KEEP_LOCKFILE.includes(testName)) {
          expect(stripWhitespace(actualLock)).toBe(stripWhitespace(expectedLock));
        } else {
          expect(stripWhitespace(stripUrlHash(actualLock))).toBe(
            stripWhitespace(stripUrlHash(expectedLock)),
          );
        }
      }
      // Cleanup
      if (!KEEP_LOCKFILE.includes(testName)) {
        removeLockfile(testName);
      }

      const expected = path.join(__dirname, testName, 'expected-install');
      const actual = path.join(__dirname, testName, 'web_modules');
      const expectedWebDependencies = await fs.readdir(expected).catch(() => {});
      if (!expectedWebDependencies) {
        // skip web_modules/ comparison for specific tests
        if (SKIP_FILE_CHECK.includes(testName)) {
          return;
        }
        // skip web_modules/ comparison for tests that start with error-*
        if (testName.startsWith('error-')) {
          return;
        }
        // throw error if web_modules/ is generated but expected-install/ is missing
        if (existsSync(actual)) throw new Error(`${actual} exists`);

        // otherwise, stop test here
        return;
      }

      // Test That all files match
      var res = dircompare.compareSync(expected, actual, {
        compareSize: true,
        // Chunk hashes created in common dependency file names are generated
        // differently on windows & linux and cause CI tests to fail
        excludeFilter: 'common',
      });
      // If any diffs are detected, we'll assert the difference so that we get nice output.
      for (const entry of res.diffSet) {
        // NOTE: We only compare files so that we give the test runner a more detailed diff.
        if (entry.type1 !== 'file') {
          return;
        }
        // NOTE: common chunks are hashed, non-trivial to compare
        if (entry.path1.endsWith('common') && entry.path2.endsWith('common')) {
          return;
        }

        if (!entry.path2)
          throw new Error(
            `File failed to generate: ${entry.path1.replace(expected, '')}/${entry.name1}`,
          );
        if (!entry.path1)
          throw new Error(
            `File not found in snapshot: ${entry.path2.replace(actual, '')}/${entry.name2}`,
          );

        const f1 = readFileSync(path.join(entry.path1, entry.name1), {encoding: 'utf8'});
        const f2 = readFileSync(path.join(entry.path2, entry.name2), {encoding: 'utf8'});

        expect(stripWhitespace(stripChunkHash(stripRev(f1)))).toBe(
          stripWhitespace(stripChunkHash(stripRev(f2))),
        );
      }
    });
  }
});
