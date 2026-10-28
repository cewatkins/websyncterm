/**
 * Optional CRT post-processing.
 *
 * The effect is implemented as a WebGL2 fragment shader when a WebGL2 context
 * is available. When it is not (or the shader fails to build), a plain
 * Canvas2D blit is used instead: the renderer keeps working, just without the
 * scanlines/curvature/glow decoration.
 */

import { createCanvas2D, get2DContext, type Context2D, type RenderCanvas } from './font.js';

/** CRT effect options. */
export interface CRTOptions {
	/** Master switch (default true). */
	enabled?: boolean;
	/** Horizontal scanlines. */
	scanlines?: boolean;
	/** Barrel distortion. */
	curvature?: boolean;
	/** Bloom / glow around bright pixels. */
	glow?: boolean;
	/** Darkened corners. */
	vignette?: boolean;
	/** Slight RGB separation. */
	aberration?: boolean;
	/** Scanline strength, 0..1. */
	scanlineIntensity?: number;
	/** Curvature strength, 0..1. */
	curvatureAmount?: number;
	/** Glow strength, 0..1. */
	glowAmount?: number;
	/** Vignette strength, 0..1. */
	vignetteAmount?: number;
	/** Chromatic aberration strength in UV units. */
	aberrationAmount?: number;
}

/** Fully resolved CRT options. */
export type ResolvedCRTOptions = Required<CRTOptions>;

/** Default effect settings. */
export const DEFAULT_CRT_OPTIONS: ResolvedCRTOptions = {
	enabled: true,
	scanlines: true,
	curvature: true,
	glow: true,
	vignette: true,
	aberration: true,
	scanlineIntensity: 0.35,
	curvatureAmount: 0.18,
	glowAmount: 0.35,
	vignetteAmount: 0.35,
	aberrationAmount: 0.0009,
};

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
	vUv = aPos * 0.5 + 0.5;
	gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uScanline;
uniform float uScanlineAmount;
uniform float uCurvature;
uniform float uGlow;
uniform float uVignette;
uniform float uAberration;

vec2 curve(vec2 uv) {
	vec2 c = uv * 2.0 - 1.0;
	vec2 offset = abs(c.yx) / vec2(6.0, 4.0);
	c += c * offset * offset * uCurvature;
	return c * 0.5 + 0.5;
}

void main() {
	vec2 uv = curve(vUv);
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
		fragColor = vec4(0.0, 0.0, 0.0, 1.0);
		return;
	}

	vec2 texel = 1.0 / max(uResolution, vec2(1.0));
	vec2 off = vec2(uAberration, 0.0);
	vec3 col;
	col.r = texture(uTex, uv + off).r;
	col.g = texture(uTex, uv).g;
	col.b = texture(uTex, uv - off).b;

	if (uGlow > 0.0) {
		vec3 glow = texture(uTex, uv + vec2(texel.x * 1.5, 0.0)).rgb;
		glow += texture(uTex, uv - vec2(texel.x * 1.5, 0.0)).rgb;
		glow += texture(uTex, uv + vec2(0.0, texel.y * 1.5)).rgb;
		glow += texture(uTex, uv - vec2(0.0, texel.y * 1.5)).rgb;
		glow *= 0.25;
		col += max(glow - 0.35, vec3(0.0)) * uGlow;
	}

	if (uScanline > 0.0) {
		float scan = 0.5 + 0.5 * sin(uv.y * uResolution.y * 3.141592653589793);
		col *= mix(1.0, mix(1.0, 0.55 + 0.45 * scan, uScanlineAmount), uScanline);
	}

	if (uVignette > 0.0) {
		vec2 v = uv * (1.0 - uv);
		float vig = clamp(v.x * v.y * 16.0, 0.0, 1.0);
		col *= mix(1.0, pow(vig, 0.35), uVignette);
	}

	fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

interface GLState {
	gl: WebGL2RenderingContext;
	program: WebGLProgram;
	texture: WebGLTexture;
	buffer: WebGLBuffer;
	vao: WebGLVertexArrayObject;
	uniforms: {
		tex: WebGLUniformLocation | null;
		resolution: WebGLUniformLocation | null;
		scanline: WebGLUniformLocation | null;
		scanlineAmount: WebGLUniformLocation | null;
		curvature: WebGLUniformLocation | null;
		glow: WebGLUniformLocation | null;
		vignette: WebGLUniformLocation | null;
		aberration: WebGLUniformLocation | null;
	};
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

function buildProgram(gl: WebGL2RenderingContext): GLState | null {
	const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
	const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
	if (!vs || !fs) {
		if (vs) gl.deleteShader(vs);
		if (fs) gl.deleteShader(fs);
		return null;
	}
	const program = gl.createProgram();
	if (!program) return null;
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		gl.deleteProgram(program);
		return null;
	}

	const buffer = gl.createBuffer();
	const vao = gl.createVertexArray();
	const texture = gl.createTexture();
	if (!buffer || !vao || !texture) return null;

	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(
		gl.ARRAY_BUFFER,
		new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
		gl.STATIC_DRAW,
	);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

	return {
		gl,
		program,
		texture,
		buffer,
		vao,
		uniforms: {
			tex: gl.getUniformLocation(program, 'uTex'),
			resolution: gl.getUniformLocation(program, 'uResolution'),
			scanline: gl.getUniformLocation(program, 'uScanline'),
			scanlineAmount: gl.getUniformLocation(program, 'uScanlineAmount'),
			curvature: gl.getUniformLocation(program, 'uCurvature'),
			glow: gl.getUniformLocation(program, 'uGlow'),
			vignette: gl.getUniformLocation(program, 'uVignette'),
			aberration: gl.getUniformLocation(program, 'uAberration'),
		},
	};
}

/** True when WebGL2 and this shader can be used. */
function probeWebGL2(): boolean {
	const canvas = createCanvas2D(2, 2);
	if (!canvas) return false;
	let gl: WebGL2RenderingContext | null = null;
	try {
		gl = (canvas as HTMLCanvasElement).getContext('webgl2') as WebGL2RenderingContext | null;
	} catch {
		gl = null;
	}
	if (!gl) return false;
	const state = buildProgram(gl);
	if (!state) {
		const ext = gl.getExtension('WEBGL_lose_context');
		ext?.loseContext();
		return false;
	}
	state.gl.deleteProgram(state.program);
	state.gl.deleteTexture(state.texture);
	state.gl.deleteBuffer(state.buffer);
	state.gl.deleteVertexArray(state.vao);
	const ext = gl.getExtension('WEBGL_lose_context');
	ext?.loseContext();
	return true;
}

/**
 * CRT post-processor drawing a rendered frame from a source canvas to its
 * target canvas.
 */
export class CRTPostProcessor {
	readonly canvas: RenderCanvas;
	private options: ResolvedCRTOptions;
	private state: GLState | null = null;
	private ctx2d: Context2D | null = null;

	constructor(canvas: RenderCanvas, options: CRTOptions = {}) {
		this.canvas = canvas;
		this.options = { ...DEFAULT_CRT_OPTIONS, ...options };
		if (this.options.enabled !== false && probeWebGL2()) {
			try {
				const gl = (canvas as HTMLCanvasElement).getContext('webgl2', {
					alpha: false,
					antialias: false,
					depth: false,
					stencil: false,
					preserveDrawingBuffer: true,
				}) as WebGL2RenderingContext | null;
				if (gl) this.state = buildProgram(gl);
			} catch {
				this.state = null;
			}
		}
		if (!this.state) this.ctx2d = get2DContext(canvas);
	}

	/** True when frames can be processed (shader or 2D fallback). */
	get active(): boolean {
		return this.options.enabled !== false && (this.state !== null || this.ctx2d !== null);
	}

	/** True when the shader path is being used. */
	get usingWebGL(): boolean {
		return this.state !== null;
	}

	/** Current options. */
	get currentOptions(): Readonly<ResolvedCRTOptions> {
		return this.options;
	}

	/** Update a subset of the options. */
	setOptions(options: CRTOptions): void {
		this.options = { ...this.options, ...options };
	}

	/** Resize hook (the viewport is set on every frame). */
	resize(): void {
		/* viewport and texture are updated in process() */
	}

	/** Draw `source` through the CRT effect. */
	process(source: CanvasImageSource): void {
		const gl = this.state?.gl;
		if (!this.state || !gl) {
			if (this.ctx2d) {
				const width = this.canvas.width;
				const height = this.canvas.height;
				this.ctx2d.imageSmoothingEnabled = false;
				this.ctx2d.clearRect(0, 0, width, height);
				this.ctx2d.drawImage(source, 0, 0, width, height);
			}
			return;
		}
		const { program, texture, vao, uniforms } = this.state;
		const width = this.canvas.width;
		const height = this.canvas.height;
		gl.viewport(0, 0, width, height);
		gl.useProgram(program);
		gl.bindVertexArray(vao);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
		gl.uniform1i(uniforms.tex, 0);
		gl.uniform2f(uniforms.resolution, width, height);
		gl.uniform1f(uniforms.scanline, this.options.scanlines ? 1 : 0);
		gl.uniform1f(uniforms.scanlineAmount, this.options.scanlineIntensity);
		gl.uniform1f(uniforms.curvature, this.options.curvature ? this.options.curvatureAmount : 0);
		gl.uniform1f(uniforms.glow, this.options.glow ? this.options.glowAmount : 0);
		gl.uniform1f(uniforms.vignette, this.options.vignette ? this.options.vignetteAmount : 0);
		gl.uniform1f(uniforms.aberration, this.options.aberration ? this.options.aberrationAmount : 0);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
	}

	/** Release GL resources. */
	destroy(): void {
		const state = this.state;
		if (state) {
			const { gl } = state;
			gl.deleteProgram(state.program);
			gl.deleteTexture(state.texture);
			gl.deleteBuffer(state.buffer);
			gl.deleteVertexArray(state.vao);
			const ext = gl.getExtension('WEBGL_lose_context');
			ext?.loseContext();
		}
		this.state = null;
		this.ctx2d = null;
	}
}
