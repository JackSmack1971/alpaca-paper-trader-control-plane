import { canonicalFileDigest } from './lib.mjs';

if (process.argv.length !== 3) {
  console.error('usage: node scripts/control-plane/canonical-digest.mjs <file>');
  process.exit(2);
}
try {
  console.log(canonicalFileDigest(process.argv[2]));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
