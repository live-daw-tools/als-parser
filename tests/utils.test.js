/**
 * Tests for pure utility functions in lib/utils.js
 */
import {
	findKeyPaths,
	findPropertiesByKey,
	getValue,
	getPluginInfo,
	getAuPluginInfo,
	getVstPluginInfo,
	getVst3PluginInfo,
	pluginTypes,
	parseXmlString,
} from '../lib/utils.js'

// ---------------------------------------------------------------------------
// findKeyPaths
// ---------------------------------------------------------------------------

describe('findKeyPaths', () => {
	test('returns empty array for null input', () => {
		expect(findKeyPaths(null, 'foo')).toEqual([])
	})

	test('returns empty array for undefined input', () => {
		expect(findKeyPaths(undefined, 'foo')).toEqual([])
	})

	test('finds a top-level key', () => {
		const obj = { foo: 'bar', baz: 123 }
		expect(findKeyPaths(obj, 'foo')).toEqual(['foo'])
	})

	test('finds a nested key', () => {
		const obj = { a: { b: { c: 'value' } } }
		expect(findKeyPaths(obj, 'c')).toEqual(['a.b.c'])
	})

	test('finds multiple occurrences of the same key', () => {
		const obj = { x: { target: 1, y: { target: 2 } }, target: 3 }
		const results = findKeyPaths(obj, 'target')
		expect(results).toContain('target')
		expect(results).toContain('x.target')
		expect(results).toContain('x.y.target')
		expect(results.length).toBe(3)
	})

	test('handles arrays in the object', () => {
		const obj = { items: [{ name: 'a' }, { name: 'b' }] }
		const results = findKeyPaths(obj, 'name')
		// findKeyPaths uses dot notation for array indices
		expect(results).toContain('items.0.name')
		expect(results).toContain('items.1.name')
	})

	test('returns empty array when key is not found', () => {
		const obj = { a: 1, b: { c: 2 } }
		expect(findKeyPaths(obj, 'missing')).toEqual([])
	})

	test('does not find keys in primitive values', () => {
		const obj = { a: 'string', b: 42, c: true }
		expect(findKeyPaths(obj, 'a')).toEqual(['a'])
		expect(findKeyPaths(obj, 'b')).toEqual(['b'])
	})

	test('uses currentPath prefix when provided', () => {
		const obj = { foo: 1 }
		expect(findKeyPaths(obj, 'foo', ['root'])).toEqual(['root.foo'])
	})
})

// ---------------------------------------------------------------------------
// findPropertiesByKey
// ---------------------------------------------------------------------------

describe('findPropertiesByKey', () => {
	test('returns empty array for empty object', () => {
		expect(findPropertiesByKey({}, ['foo'])).toEqual([])
	})

	test('finds a top-level matching key', () => {
		const obj = { SampleRef: { FileRef: {} }, other: 'x' }
		const results = findPropertiesByKey(obj, ['SampleRef'])
		expect(results).toHaveLength(1)
		expect(results[0].key).toBe('SampleRef')
		expect(results[0].path).toBe('SampleRef')
		expect(results[0].value).toEqual({ FileRef: {} })
	})

	test('finds nested matching keys', () => {
		const obj = { a: { b: { PluginDesc: { type: 'AU' } } } }
		const results = findPropertiesByKey(obj, ['PluginDesc'])
		expect(results).toHaveLength(1)
		expect(results[0].path).toBe('a.b.PluginDesc')
	})

	test('finds multiple matching keys across object', () => {
		const obj = {
			track1: { PluginDesc: { type: 'AU' } },
			track2: { PluginDesc: { type: 'VST' } },
		}
		const results = findPropertiesByKey(obj, ['PluginDesc'])
		expect(results).toHaveLength(2)
	})

	test('finds multiple different target keys', () => {
		const obj = { SampleRef: {}, PluginDesc: {}, other: 'x' }
		const results = findPropertiesByKey(obj, ['SampleRef', 'PluginDesc'])
		expect(results).toHaveLength(2)
		const keys = results.map((r) => r.key)
		expect(keys).toContain('SampleRef')
		expect(keys).toContain('PluginDesc')
	})

	test('handles arrays at top level', () => {
		const arr = [{ PluginDesc: { type: 'AU' } }, { PluginDesc: { type: 'VST' } }]
		const results = findPropertiesByKey(arr, ['PluginDesc'])
		expect(results).toHaveLength(2)
	})

	test('handles null values inside objects without throwing', () => {
		const obj = { a: null, b: { PluginDesc: {} } }
		const results = findPropertiesByKey(obj, ['PluginDesc'])
		expect(results).toHaveLength(1)
	})

	test('returns correct path string for nested array items', () => {
		const obj = { tracks: [{ PluginDesc: {} }] }
		const results = findPropertiesByKey(obj, ['PluginDesc'])
		expect(results[0].path).toBe('tracks[0].PluginDesc')
	})
})

// ---------------------------------------------------------------------------
// getValue
// ---------------------------------------------------------------------------

describe('getValue', () => {
	test('returns the $.Value from an object', () => {
		const obj = { $: { Value: '128' } }
		expect(getValue(obj)).toBe('128')
	})

	test('returns numeric Value', () => {
		const obj = { $: { Value: 120.5 } }
		expect(getValue(obj)).toBe(120.5)
	})

	test('throws when $.Value is not present', () => {
		const obj = { something: 'else' }
		expect(() => getValue(obj)).toThrow('Unexpected object structure')
	})

	test('throws when object is null', () => {
		expect(() => getValue(null)).toThrow()
	})

	test('throws when object is undefined', () => {
		expect(() => getValue(undefined)).toThrow()
	})
})

// ---------------------------------------------------------------------------
// getAuPluginInfo
// ---------------------------------------------------------------------------

describe('getAuPluginInfo', () => {
	test('extracts AU plugin name and manufacturer', () => {
		const PluginDesc = {
			AuPluginInfo: {
				Name: { $: { Value: 'Reverb' } },
				Manufacturer: { $: { Value: 'Apple' } },
			},
		}
		const result = getAuPluginInfo(PluginDesc)
		expect(result.name).toBe('Reverb')
		expect(result.manufacturer).toBe('Apple')
		expect(result.path).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// getVstPluginInfo
// ---------------------------------------------------------------------------

describe('getVstPluginInfo', () => {
	test('extracts VST plugin name and path', () => {
		const PluginDesc = {
			VstPluginInfo: {
				PlugName: { $: { Value: 'Serum' } },
				Path: { $: { Value: '/Library/Audio/Plug-Ins/VST/Serum.vst' } },
			},
		}
		const result = getVstPluginInfo(PluginDesc)
		expect(result.name).toBe('Serum')
		expect(result.path).toBe('/Library/Audio/Plug-Ins/VST/Serum.vst')
		expect(result.manufacturer).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// getVst3PluginInfo
// ---------------------------------------------------------------------------

describe('getVst3PluginInfo', () => {
	test('extracts VST3 plugin name', () => {
		const PluginDesc = {
			Vst3PluginInfo: {
				Name: { $: { Value: 'Vital' } },
			},
		}
		const result = getVst3PluginInfo(PluginDesc)
		expect(result.name).toBe('Vital')
		expect(result.path).toBeNull()
		expect(result.manufacturer).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// getPluginInfo (dispatcher)
// ---------------------------------------------------------------------------

describe('getPluginInfo', () => {
	test('returns AU type and info for AuPluginInfo', () => {
		const PluginDesc = {
			AuPluginInfo: {
				Name: { $: { Value: 'Reverb' } },
				Manufacturer: { $: { Value: 'Apple' } },
			},
		}
		const result = getPluginInfo(PluginDesc)
		expect(result[0]).toBe(pluginTypes.AuPluginInfo)
		expect(result[0]).toBe('AU')
		expect(result[1].name).toBe('Reverb')
	})

	test('returns VST type and info for VstPluginInfo', () => {
		const PluginDesc = {
			VstPluginInfo: {
				PlugName: { $: { Value: 'Serum' } },
				Path: { $: { Value: '/path/to/Serum.vst' } },
			},
		}
		const result = getPluginInfo(PluginDesc)
		expect(result[0]).toBe(pluginTypes.VstPluginInfo)
		expect(result[0]).toBe('VST')
		expect(result[1].name).toBe('Serum')
	})

	test('returns VST3 type and info for Vst3PluginInfo', () => {
		const PluginDesc = {
			Vst3PluginInfo: {
				Name: { $: { Value: 'Vital' } },
			},
		}
		const result = getPluginInfo(PluginDesc)
		expect(result[0]).toBe(pluginTypes.Vst3PluginInfo)
		expect(result[0]).toBe('VST3')
		expect(result[1].name).toBe('Vital')
	})

	test('returns empty array for unknown plugin type', () => {
		const PluginDesc = { ClapPluginInfo: { Name: 'Unknown' } }
		const result = getPluginInfo(PluginDesc)
		expect(result).toEqual([])
	})
})

// ---------------------------------------------------------------------------
// parseXmlString - error handling
// ---------------------------------------------------------------------------

describe('parseXmlString error handling', () => {
	test('throws for invalid XML', async () => {
		await expect(
			parseXmlString('<invalid><not closed'),
		).rejects.toThrow('Error parsing XML')
	})

	test('parses well-formed XML', async () => {
		const xml = '<Root attr="hello"><Child value="42"/></Root>'
		const result = await parseXmlString(xml)
		expect(result).toBeDefined()
	})
})
