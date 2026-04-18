import * as lib from '../lib/utils.js'
import _ from 'lodash-es'

const TEST_FILE_PATH = './tests/test-data/projects/Michelle.als'
const TEST_PROJECT_FOLDER = './tests/test-data/projects/Test Project'

test('gets file info', async () => {
	let results = await lib.getFileInfo(TEST_FILE_PATH)
	// console.log(results)
	expect(results.name).toBe('Michelle.als')
})

test('getFileInfo returns expected fields', async () => {
	let results = await lib.getFileInfo(TEST_FILE_PATH)
	expect(results).toHaveProperty('name')
	expect(results).toHaveProperty('path')
	expect(results).toHaveProperty('size')
	expect(results).toHaveProperty('sha256')
	expect(results).toHaveProperty('created')
	expect(results).toHaveProperty('modified')
	expect(typeof results.size).toBe('number')
	expect(results.sha256).toMatch(/^[a-f0-9]{64}$/)
})

test('getFileInfo throws for non-existent file', async () => {
	await expect(lib.getFileInfo('./nonexistent.als')).rejects.toThrow(
		'Error processing file',
	)
})

test('read .als zip file', async () => {
	let results = await lib.readZipContents(TEST_FILE_PATH)
	expect(results.indexOf('<?xml version="1.0" encoding="UTF-8"?>')).toBe(0)
})

test('readZipContents throws for non-existent file', async () => {
	await expect(lib.readZipContents('./nonexistent.als')).rejects.toThrow(
		'Error reading zip file',
	)
})

test('parse xml', async () => {
	let raw = await lib.readZipContents(TEST_FILE_PATH)
	let results = await lib.parseXmlString(raw)

	let keys = _.keys(results)
	expect(keys[0]).toBe('$')
	expect(keys[1]).toBe('LiveSet')
})

test('findAlsFiles', async () => {
	let files = await lib.findAlsFiles('./tests/test-data/projects/')
	// console.log(files.length)

	expect(files.length).toBe(5)

	let filenames = files.map((f) => f.split('/').pop())
	expect(filenames).toContain('Michelle.als')
	expect(filenames).toContain('Test Project.als')
})

test('findAlsFiles excludes backup files by default', async () => {
	let files = await lib.findAlsFiles('./tests/test-data/projects/')
	let filenames = files.map((f) => f.split('/').pop())
	// Backup files like "Bar [2024-10-26 140532].als" should be excluded
	const hasBackup = filenames.some(
		(f) => f.includes('[') && f.includes(']'),
	)
	expect(hasBackup).toBe(false)
})

test('findAlsFiles includes backup files when backups: true', async () => {
	let files = await lib.findAlsFiles('./tests/test-data/projects/', {
		backups: true,
	})
	// Should include the 5 regular files + 2 backup files
	expect(files.length).toBe(7)
	let filenames = files.map((f) => f.split('/').pop())
	const hasBackup = filenames.some(
		(f) => f.includes('[') && f.includes(']'),
	)
	expect(hasBackup).toBe(true)
})

test('validating a project folder', async () => {
	let results = await lib.validateAbletonProject(TEST_PROJECT_FOLDER)
	// console.log(results)
	expect(results.isValid).toBe(true)
})

test('validateAbletonProject returns name without " Project" suffix', async () => {
	let results = await lib.validateAbletonProject(TEST_PROJECT_FOLDER)
	expect(results.name).toBe('Test')
})

test('validateAbletonProject fails when path is a file, not a directory', async () => {
	let results = await lib.validateAbletonProject(TEST_FILE_PATH)
	expect(results.isValid).toBe(false)
	expect(results.errors).toContain('Path is not a directory')
})

test('validateAbletonProject fails when folder name does not end with " Project"', async () => {
	// The projects root directory itself doesn't end with " Project"
	let results = await lib.validateAbletonProject('./tests/test-data/projects')
	expect(results.isValid).toBe(false)
	expect(results.errors).toContain("Folder name does not end with ' Project'")
})

test('validateAbletonProject reports missing .als files and missing Ableton Project Info', async () => {
	let results = await lib.validateAbletonProject(
		'./tests/test-data/projects/Invalid Project',
	)
	expect(results.isValid).toBe(false)
	expect(results.errors).toContain('No .als files found in directory')
	expect(results.errors).toContain("'Ableton Project Info' folder not found")
})

test('failing a non-existent folder', async () => {
	let results = await lib.validateAbletonProject('./foobarbaz')

	// expect(1).toBe(1)
	expect(results.isValid).toBe(false)
	expect(results.errors[0]).toBe('Path does not exist')
})

test('finding ableton project directories', async () => {
	let results = await lib.findAbletonProjects('./tests/test-data/projects/')

	expect(results.valid.length).toBe(3)
	expect(results.invalid.length).toBe(1)
	expect(results.invalid[0].isValid).toBe(false)

	/**
	 *  [
        'No .als files found in directory',
        "'Ableton Project Info' folder not found"
      ]
	 */

	expect(results.invalid[0].errors.length).toBe(2)
})

test('findAbletonProjects valid projects have expected fields', async () => {
	let results = await lib.findAbletonProjects('./tests/test-data/projects/')
	const validProject = results.valid[0]
	expect(validProject).toHaveProperty('isValid', true)
	expect(validProject).toHaveProperty('path')
	expect(validProject).toHaveProperty('name')
})

test('readZipContentsStreaming yields correct stages', async () => {
	const stages = []
	for await (const event of lib.readZipContentsStreaming(TEST_FILE_PATH)) {
		stages.push(event.stage)
		if (event.stage === 'complete') break
	}
	expect(stages).toContain('reading')
	expect(stages).toContain('unzipping')
	expect(stages[stages.length - 1]).toBe('complete')
})

test('readZipContentsStreaming complete event contains XML data', async () => {
	let completeData = null
	for await (const event of lib.readZipContentsStreaming(TEST_FILE_PATH)) {
		if (event.stage === 'complete') {
			completeData = event.data
		}
	}
	expect(completeData).not.toBeNull()
	expect(completeData.startsWith('<?xml version="1.0"')).toBe(true)
})

test('readZipContentsStreaming yields error stage for bad file', async () => {
	const events = []
	try {
		for await (const event of lib.readZipContentsStreaming('./nonexistent.als')) {
			events.push(event)
		}
	} catch (e) {
		// expected to throw after yielding error
	}
	const errorEvent = events.find((e) => e.stage === 'error')
	expect(errorEvent).toBeDefined()
})

test('findAlsFilesStreaming yields scanning and found events', async () => {
	const events = []
	for await (const event of lib.findAlsFilesStreaming(
		'./tests/test-data/projects/',
	)) {
		events.push(event)
	}
	const types = events.map((e) => e.type)
	expect(types).toContain('scanning')
	expect(types).toContain('found')
	expect(types[types.length - 1]).toBe('complete')
})

test('findAlsFilesStreaming found events have file path', async () => {
	const foundEvents = []
	for await (const event of lib.findAlsFilesStreaming(
		'./tests/test-data/projects/',
	)) {
		if (event.type === 'found') foundEvents.push(event)
	}
	expect(foundEvents.length).toBe(5)
	const filenames = foundEvents.map((e) => e.file.split('/').pop())
	expect(filenames).toContain('Michelle.als')
})

test('findAlsFilesStreaming with backups:true includes backup files', async () => {
	const foundEvents = []
	for await (const event of lib.findAlsFilesStreaming(
		'./tests/test-data/projects/',
		{ backups: true },
	)) {
		if (event.type === 'found') foundEvents.push(event)
	}
	expect(foundEvents.length).toBe(7)
})

test('findAlsFilesStreaming excludes backup files by default', async () => {
	const foundEvents = []
	for await (const event of lib.findAlsFilesStreaming(
		'./tests/test-data/projects/',
	)) {
		if (event.type === 'found') foundEvents.push(event)
	}
	const hasBackup = foundEvents.some(
		(e) => e.file.includes('[') && e.file.includes(']'),
	)
	expect(hasBackup).toBe(false)
})

test('findAbletonProjectsStreaming yields expected event types', async () => {
	const events = []
	for await (const event of lib.findAbletonProjectsStreaming(
		'./tests/test-data/projects/',
	)) {
		events.push(event)
	}
	const types = events.map((e) => e.type)
	expect(types).toContain('scanning')
	expect(types).toContain('project-found')
	expect(types[types.length - 1]).toBe('complete')
})

test('findAbletonProjectsStreaming yields valid and invalid projects', async () => {
	const projectEvents = []
	for await (const event of lib.findAbletonProjectsStreaming(
		'./tests/test-data/projects/',
	)) {
		if (event.type === 'project-found') projectEvents.push(event)
	}
	const validProjects = projectEvents.filter((e) => e.isValid)
	const invalidProjects = projectEvents.filter((e) => !e.isValid)
	expect(validProjects.length).toBe(3)
	expect(invalidProjects.length).toBe(1)
})
