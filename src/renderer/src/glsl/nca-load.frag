precision highp float;
precision highp sampler2D;
precision highp int;

// Copies a state held in three plain textures into the automaton's targets.

in vec2 vUv;
layout(location = 0) out vec4 outState0;
layout(location = 1) out vec4 outState1;
layout(location = 2) out vec4 outState2;

uniform sampler2D ncaState0;
uniform sampler2D ncaState1;
uniform sampler2D ncaState2;
uniform int ncaGrid;

void main() {
  ivec2 cell = ivec2(floor(vUv * float(ncaGrid)));
  outState0 = texelFetch(ncaState0, cell, 0);
  outState1 = texelFetch(ncaState1, cell, 0);
  outState2 = texelFetch(ncaState2, cell, 0);
}
