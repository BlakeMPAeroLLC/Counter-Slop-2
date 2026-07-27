import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Math methods whose results are exactly specified by ECMAScript / IEEE-754 and are
 * therefore safe inside the deterministic simulation:
 *   abs ceil floor round trunc sign min max sqrt fround imul clz32
 *
 * Everything else in `Math` is implementation-approximated. V8, SpiderMonkey and
 * JavaScriptCore are each free to return different last-bit results for sin/cos/pow/exp/log,
 * which would silently desync a Firefox client from a Node (V8) server. `packages/sim`
 * uses its own polynomial `dsin`/`dcos` instead — see packages/sim/src/math.ts.
 */
const FORBIDDEN_MATH = [
  'random',
  'sin', 'cos', 'tan',
  'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'cbrt', 'hypot',
]

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Determinism guard. `packages/sim` runs on both the client and the server and
  // its output must be bit-identical on every engine, or client prediction and
  // rollback reconciliation (M1) will produce phantom divergence that is
  // extremely painful to debug. These bans are load-bearing, not stylistic.
  // ───────────────────────────────────────────────────────────────────────────
  {
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Non-deterministic. The sim advances by tick count only.' },
        { name: 'performance', message: 'Non-deterministic. The sim advances by tick count only.' },
        { name: 'window', message: 'sim must run headless on the server too.' },
        { name: 'document', message: 'sim must run headless on the server too.' },
        { name: 'navigator', message: 'sim must run headless on the server too.' },
        { name: 'localStorage', message: 'sim must run headless on the server too.' },
        { name: 'process', message: 'sim must run in the browser too.' },
        { name: 'setTimeout', message: 'The sim is stepped by its host, never self-scheduled.' },
        { name: 'setInterval', message: 'The sim is stepped by its host, never self-scheduled.' },
      ],
      'no-restricted-properties': [
        'error',
        ...FORBIDDEN_MATH.map((prop) => ({
          object: 'Math',
          property: prop,
          message:
            `Math.${prop} is implementation-approximated and differs across JS engines. ` +
            `Use the deterministic helpers in sim/math.ts (dsin, dcos, dsqrt, rngNext).`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Non-deterministic. The sim advances by tick count only.',
        },
        {
          selector: "CallExpression[callee.object.name='Object'][callee.property.name='keys']",
          message:
            'Iterate fixed-length typed arrays instead — key order is a subtle desync source.',
        },
      ],
    },
  },

  // Tests and tools may use whatever they like.
  {
    files: ['**/*.test.ts', '**/tests/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
)
