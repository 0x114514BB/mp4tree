import { describe, expect, test } from '@jest/globals';
import { MP4Tree } from '../src/mp4Tree';

// Get test file using readFileSync from ./test-file.mp4:
// const file = readFileSync('./tests/test-file.mp4');

const fileStr = './tests/test-file.mp4';

describe('MP4Treejs', () => {
  test('Parse MP4Tree', async () => {
    const mp4 = new MP4Tree(fileStr);
    await mp4.parse();
    expect(mp4.root.size).toBe(16506);
  });
});