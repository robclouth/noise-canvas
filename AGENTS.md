- Comments should only explain the functionality of the code, not what you've changed.
- After big changes, run "npm run test:run" to run tests.
- When creating tests, you can't just duplicate all of the logic of the code that you're testing in the test. You must use the original code as much as possible.
- Never use "any" type.
- Use "npx node-gyp rebuild" to rebuild the gaborator addon after changing the C++ code.

## Project Architecture

This is a spectrogram editor built with Electron, React, and Three.js/WebGL. Users can "paint" on spectrograms to modify audio.

### Core Components

**Renderer Process** (`src/renderer/src/`)
- `app.tsx` - Main app component. Single shared `<Canvas>` with `<View.Port />` for all file views.
- `components/file-view.tsx` - Wrapper for each open file. Contains gesture handling, mouse events, grid snapping. Creates a `<View>` with `<FileRenderer>` inside.
- `components/file-renderer.tsx` - React component that manages WebGL rendering for a single file. Exposes `FileRendererHandle` interface with methods like `renderStroke()`, `getFBOData()`, `getTextures()`, `ensureInitialized()`.
- `lib/stroke-renderer.ts` - Core WebGL stroke rendering logic. Extracted from FileRenderer to enable unit testing. Handles FBO ping-pong, effect chains, and brush application.

**State Management** (`src/renderer/src/store/`)
- Uses Zustand. Main store created with slices for different concerns.
- `files.ts` - File management (open, close, save), source file selection, synthesis
- `brush.ts` - Brush-related state and actions
- `modulators.ts` - Modulator parameters and types
- `types.ts` - TypeScript types for the store

**Parameters** (`src/renderer/src/parameters.ts`)
- Central definition of ALL parameters (brush, effects, modulators, app settings)
- Each parameter has: kind, name, label, description, default, min/max, unit, etc.
- `modulatable` flag indicates if a parameter can be modulated
- `includeInStep` flag indicates if parameter is per-step
- `effectType` associates parameters with specific effects

**Effects** (`src/renderer/src/effects/`)
- Each effect (blur, transform, dynamics, overtones, synthesize, evolve, passthrough) has its own file
- Effects have one or more shader passes (materials)
- `base-effect.ts` - Base class and shared uniforms
- Effects are registered in an `EffectsRegistry` and applied in order

**Shaders** (`src/renderer/src/glsl/`)
- `effect-common.glsl` - Shared uniforms and sampling functions for all effects
- `modulation-common.glsl` - Modulator logic (patterns, sequencer, envelope follower, IMAGE mode)
- `common.glsl` - Basic constants and utilities
- Each effect has its own `.frag` file

### Key Data Flow

1. **Spectrogram Data**: Audio → Gaborator analysis → `SpectrogramData` with packed textures
2. **Rendering**: `FileRenderer` creates `StrokeRenderer` with textures → FBOs for ping-pong rendering
3. **Strokes**: Mouse events → `renderStroke()` → effect chain processes source→dest with brush envelope
4. **Source Files**: When painting from file B onto file A:
   - `sourceFile` in state points to B's file ID
   - `FileRenderer` gets B's textures via `rendererRef.current.getTextures()`
   - `SourceFileInfo` passed to `StrokeRenderer.renderStroke()` with B's spectrogramData and textures
   - Shader samples from source texture using source file's metadata (frameCount, bandCount, etc.)

### Uniform System

Uniforms are passed to shaders as objects with `.value` property. Key uniform groups:
- `source*` - Source file data (texture, metadata, dimensions)
- `dest*` - Destination file data
- `brush*` - Brush position, size, intensity
- `modulator*` - Modulator parameters (3 modulators supported)
- `envelope*` - ADSR envelope boundaries

**CRITICAL**: When reusing uniform objects across passes, be careful about shared references. The original code creates fresh uniform copies per pass to avoid mutation issues. Optimizations that reuse objects must ensure source/dest uniforms don't share references.

### Modulator System

3 modulators, each with:
- Mode: Off, Pattern, Envelope Follower, Sequencer
- Pattern shapes: Sine, Triangle, Square, Sawtooth, Noise, Perlin, IMAGE (uses texture)
- Parameters defined in `parameters.ts` as `modulator${idx}*`
- Texture loading in `lib/textures.ts` via `useModulatorTexture()` hook

### Testing

- Vitest with Playwright for WebGL tests
- Tests in `src/renderer/src/lib/__tests__/`
- `stroke-renderer.test.ts` - Main stroke rendering tests
- `effects.test.ts` - Effect-specific tests
- Mock helpers create spectrogram data, textures, and state for isolated testing
