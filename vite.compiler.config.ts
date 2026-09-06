import { mergeConfig } from 'vite';
import { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import baseConfig from './vite.config.ts';

// Trial only: the main editor still has compiler diagnostics to resolve.
const preset = reactCompilerPreset();
preset.rolldown.filter = {
  ...preset.rolldown.filter,
  id: { include: /src[\\/]ui[\\/](catalog[\\/]WarpaintList|workbench[\\/]DiagnosticItem)\.tsx$/ },
};

export default mergeConfig(baseConfig, {
  plugins: [babel({ presets: [preset] })],
  build: { outDir: '.tmp/compiler-dist' },
});
