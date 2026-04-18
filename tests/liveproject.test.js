import { LiveProject, LiveSet } from '../index.js'
import path from 'node:path'

const TEST_PROJECT_PATH = path.resolve(
	'./tests/test-data/projects/Test Project',
)
const TEST_PROJECT_FOLDER = 'Test Project'
const TEST_PROJECT_NAME = 'Test'

test('loading a project', async () => {
	let _project = await new LiveProject(TEST_PROJECT_PATH)
	expect(_project.path).toBe(TEST_PROJECT_PATH)
	expect(_project.name).toBe('Test')
	expect(_project.liveSetPaths.length).toBe(1)
	expect(_project.liveSetPaths[0]).toBe(
		`${TEST_PROJECT_PATH}/${TEST_PROJECT_FOLDER}.als`,
	)
})

test('loading sets in a project', async () => {
	let _project = await new LiveProject(TEST_PROJECT_PATH)

	await _project.loadSets()

	expect(_project.liveSets).toHaveLength(1)
	expect(_project.liveSets[0].info.name).toBe(`${TEST_PROJECT_FOLDER}.als`)
})

test('LiveProject throws for an invalid directory', async () => {
	await expect(new LiveProject('./tests/test-data/projects/Invalid Project')).rejects.toMatch(
		/isn't an Ableton project/,
	)
})

test('LiveProject throws for a non-existent directory', async () => {
	await expect(new LiveProject('./nonexistent-folder')).rejects.toMatch(
		/isn't an Ableton project/,
	)
})

test('LiveProject isValid returns true for a valid project', async () => {
	let _project = await new LiveProject(TEST_PROJECT_PATH)
	expect(_project.isValid).toBe(true)
})

test('LiveProject emits progress events during loadSets', async () => {
	let _project = await new LiveProject(TEST_PROJECT_PATH)

	const stages = []
	_project.on('progress', (event) => {
		stages.push(event.stage)
	})

	await _project.loadSets()

	expect(stages).toContain('loading-sets')
	expect(stages).toContain('complete')
})

test('LiveProject progress events include completed and total counts', async () => {
	let _project = await new LiveProject(TEST_PROJECT_PATH)

	const events = []
	_project.on('progress', (event) => {
		events.push(event)
	})

	await _project.loadSets()

	const completeEvent = events.find((e) => e.stage === 'complete')
	expect(completeEvent).toBeDefined()
	expect(completeEvent.percent).toBe(100)
	expect(completeEvent.total).toBe(1)
	expect(completeEvent.completed).toBe(1)
})

test('LiveProject emits set-progress events during loadSets', async () => {
	let _project = await new LiveProject(TEST_PROJECT_PATH)

	const setProgressEvents = []
	_project.on('set-progress', (event) => {
		setProgressEvents.push(event)
	})

	await _project.loadSets()

	expect(setProgressEvents.length).toBeGreaterThan(0)
	// set-progress events should include path and setIndex
	const firstEvent = setProgressEvents[0]
	expect(firstEvent).toHaveProperty('path')
	expect(firstEvent).toHaveProperty('setIndex')
})

test('LiveProject liveSetPaths excludes backup files', async () => {
	const fooProjectPath = path.resolve('./tests/test-data/projects/Foo Project')
	let _project = await new LiveProject(fooProjectPath)
	expect(_project.liveSetPaths).toHaveLength(1)
	const hasBackup = _project.liveSetPaths.some(
		(p) => p.includes('[') && p.includes(']'),
	)
	expect(hasBackup).toBe(false)
})
