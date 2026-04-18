import { LiveSet } from '../index.js'
import _ from 'lodash-es'

const TEST_PROJECT_FILE = './tests/test-data/projects/Michelle.als'

test('we get the expected metadata back', async () => {
	let set = await new LiveSet(TEST_PROJECT_FILE)

	expect(set.info.name).toBe('Michelle.als')
	expect(set.info.trackCount).toBe(9)
	expect(set.info.version.app).toBe('Ableton Live')
	expect(set.info.version.major).toBe(11)
	expect(set.info.version.minor).toBe(3)
	expect(set.info.version.patch).toBe(21)
	expect(set.info.sha256).toBe(
		'a79d07d37eba73a8ec631a8ad14d5ab0b6a8bbf0bebb98d934e0eb93f98b67c7',
	)
})

test('getting tempo from different set files', async () => {
	let foo = await new LiveSet('./tests/test-data/projects/Foo Project/Foo.als')

	// console.log('XXX info', foo.info)

	// expect(foo.tempo).toBe('NaN')

	expect(foo.tempo).toBe('199.99')
	let bar = await new LiveSet('./tests/test-data/projects/Bar Project/Bar.als')
	// expect(bar.tempo).toBe('104.50')
})

test('loading a Live 12.3 als file', async () => {
	let set = await new LiveSet('./tests/test-data/projects/Michelle-12.3.als')

	expect(set.info.name).toBe('Michelle-12.3.als')
	expect(set.info.trackCount).toBe(9)
	expect(set.info.version.app).toBe('Ableton Live')
	expect(set.info.version.major).toBe(12)
	expect(set.info.version.minor).toBe(3)
	expect(set.info.version.patch).toBe(2)
	expect(set.info.sha256).toBe(
		'365ca6ed7b4bb2e787e4be0923fbe55d1acf70a5829bfdb5d29c36104b36b0c7',
	)
})

test('version parsing supports different Creator formats', () => {
	const testCases = [
		{
			creator: 'Ableton Live 12.3.2',
			expected: { app: 'Ableton Live', major: 12, minor: 3, patch: 2 },
		},
		{
			creator: 'Ableton Live 11.3.21',
			expected: { app: 'Ableton Live', major: 11, minor: 3, patch: 21 },
		},
		{
			creator: 'Ableton Live 10.1',
			expected: { app: 'Ableton Live', major: 10, minor: 1, patch: 0 },
		},
		{
			creator: 'Ableton Live 9.7',
			expected: { app: 'Ableton Live', major: 9, minor: 7, patch: 0 },
		},
	]

	testCases.forEach(({ creator, expected }) => {
		const regex = /([a-zA-Z\ ]+)\ ([0-9]+)\.([\d]+)(?:\.([\d]+))?/
		const pieces = regex.exec(creator)

		const result = {
			app: pieces[1],
			major: parseInt(pieces[2]),
			minor: parseInt(pieces[3]),
			patch: parseInt(pieces[4]) || 0,
		}

		expect(result).toEqual(expected)
	})
})

test('track and device parsing', async () => {
	let set = await new LiveSet('./tests/test-data/projects/Michelle-12.3.als')

	// console.log('Set name:', set.info.name)
	// console.log('Tracks:', set.tracks)

	expect(set.info.trackCount).toBe(9)

	expect(_.keys(set.tracks).sort()).toEqual([
		'AudioTrack',
		'GroupTrack',
		'MidiTrack',
		'ReturnTrack',
	])

	let kickTrack = set.tracks.AudioTrack[0]

	console.log(kickTrack)

	expect(kickTrack.name).toBe('Kick')
	expect(kickTrack.devices.length).toBe(1)
	expect(kickTrack.devices[0]).toBe('StereoGain')
})

test('LiveSet.create static factory creates an initialized instance', async () => {
	let set = await LiveSet.create(TEST_PROJECT_FILE)
	expect(set.initialized).toBe(true)
	expect(set.info.name).toBe('Michelle.als')
})

test('LiveSet with autoInit: false does not auto-initialize', () => {
	const set = new LiveSet(TEST_PROJECT_FILE, { autoInit: false })
	expect(set.initialized).toBe(false)
})

test('LiveSet.init() initializes the set after autoInit: false', async () => {
	const set = new LiveSet(TEST_PROJECT_FILE, { autoInit: false })
	expect(set.initialized).toBe(false)
	await set.init()
	expect(set.initialized).toBe(true)
	expect(set.info.name).toBe('Michelle.als')
})

test('LiveSet emits progress events during read', async () => {
	const set = new LiveSet(TEST_PROJECT_FILE, { autoInit: false })
	const stages = []

	set.on('progress', (event) => {
		stages.push(event.stage)
	})

	await set.init()

	expect(stages).toContain('reading-file')
	expect(stages).toContain('parsing-xml')
	expect(stages).toContain('complete')
})

test('LiveSet progress events include percent values', async () => {
	const set = new LiveSet(TEST_PROJECT_FILE, { autoInit: false })
	const events = []

	set.on('progress', (event) => {
		events.push(event)
	})

	await set.init()

	const completeEvent = events.find((e) => e.stage === 'complete')
	expect(completeEvent).toBeDefined()
	expect(completeEvent.percent).toBe(100)
})

test('LiveSet throws for non-existent file', async () => {
	await expect(LiveSet.create('./nonexistent.als')).rejects.toThrow()
})

test('LiveSet tempo is formatted to 2 decimal places', async () => {
	let set = await new LiveSet(TEST_PROJECT_FILE)
	expect(set.tempo).toMatch(/^\d+\.\d{2}$/)
})

test('LiveSet info includes all expected top-level fields', async () => {
	let set = await new LiveSet(TEST_PROJECT_FILE)
	const info = set.info
	expect(info).toHaveProperty('name')
	expect(info).toHaveProperty('tempo')
	expect(info).toHaveProperty('version')
	expect(info).toHaveProperty('tracks')
	expect(info).toHaveProperty('trackCount')
	expect(info).toHaveProperty('size')
	expect(info).toHaveProperty('sha256')
})

test('LiveSet tracks includes device info for each track', async () => {
	let set = await new LiveSet('./tests/test-data/projects/Michelle-12.3.als')
	const tracks = set.tracks

	// All AudioTracks should have name, devices, and plugins arrays
	tracks.AudioTrack.forEach((track) => {
		expect(track).toHaveProperty('name')
		expect(track).toHaveProperty('devices')
		expect(track).toHaveProperty('plugins')
		expect(Array.isArray(track.devices)).toBe(true)
		expect(Array.isArray(track.plugins)).toBe(true)
	})
})

test('LiveSet trackCount only counts AudioTrack and MidiTrack', async () => {
	let set = await new LiveSet('./tests/test-data/projects/Michelle-12.3.als')
	// trackCount specifically counts AudioTrack + MidiTrack (not GroupTrack/ReturnTrack)
	expect(set.trackCount).toBe(9)
})

test('LiveSet parsed property exposes raw parsed XML', async () => {
	let set = await new LiveSet(TEST_PROJECT_FILE)
	const parsed = set.parsed
	expect(parsed).toHaveProperty('$')
	expect(parsed).toHaveProperty('LiveSet')
	expect(parsed.LiveSet).toHaveProperty('Tracks')
})
