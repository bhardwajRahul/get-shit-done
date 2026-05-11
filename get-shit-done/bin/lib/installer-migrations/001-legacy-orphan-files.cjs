'use strict';

const LEGACY_ORPHAN_FILES = [
  'hooks/gsd-notify.sh',
  'hooks/statusline.js',
];

module.exports = {
  id: '2026-05-11-legacy-orphan-files',
  title: 'Remove manifest-managed legacy orphan hook files',
  description: 'Remove legacy orphan hook files that are still manifest-managed.',
  introducedIn: '1.50.0',
  scopes: ['global', 'local'],
  destructive: true,
  plan: ({ classifyArtifact }) => {
    const actions = [];
    for (const relPath of LEGACY_ORPHAN_FILES) {
      const artifact = classifyArtifact(relPath);
      if (artifact.classification === 'managed-pristine' || artifact.classification === 'managed-modified') {
        actions.push({
          type: 'remove-managed',
          relPath,
          reason: 'legacy orphan hook file retired by installer migration',
        });
      }
    }
    return actions;
  },
};
