import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageFromLabel } from '../src/communityProvider.js';

test('original audio uses the requested title language while shared audio stays unknown', () => {
    assert.equal(languageFromLabel('Castle [OST] - 1080P', 'en'), 'en');
    assert.equal(languageFromLabel('Castle [OST] - 1080P', 'ko'), 'ko');
    assert.equal(languageFromLabel('Castle [OST] - 1080P'), 'und');
    assert.equal(languageFromLabel('Castle [Shared] - 1080P', 'en'), 'und');
    assert.equal(languageFromLabel('Castle [Hindi] - 720P', 'en'), 'hi');
});
