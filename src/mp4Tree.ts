/* eslint-disable complexity */
import {MP4TreeAtom} from './mp4TreeAtom';
import {open, stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {PassThrough} from 'node:stream';
import {pipeline} from 'stream/promises';

// eslint-disable-next-line @typescript-eslint/naming-convention
export class MP4Tree {
	// MP4Tree
	static createMetaDataAtom = (name: string, ilst: MP4TreeAtom, content: string | Buffer) => {
		const nodeAtom = new MP4TreeAtom(name, ilst);
		const dataAtom = new MP4TreeAtom('data', nodeAtom);
		if (Buffer.isBuffer(content)) {
			const loadFunction = name === 'covr' ? dataAtom.loadMetaDataJpeg : dataAtom.loadMetaDataBuffer;
			loadFunction(content);
		} else {
			dataAtom.loadMetaDataString(content);
		}

		nodeAtom.addChild(dataAtom);
		ilst.addChild(nodeAtom);
		return nodeAtom;
	};

	isValid = false;
	fileDir: string;
	root: MP4TreeAtom;
	size = -1;

	constructor(input: string) {
		this.fileDir = input;
		// First thing to do is establish the root Atom - but from then on this can all be recursive.
		this.root = new MP4TreeAtom('root');

		// This.isValid = this.root.hasChild('ftyp'); // moov is also a valid checker.
	}

	async parse() {
		await stat(this.fileDir).then(
			stats => {
				this.size = stats.size;
				this.root.size = this.size;
				this.isValid = true;
			},
		).catch(
			err => {
				console.log(`[MP4Tree ERROR] ${err}`);
				this.isValid = false;
			},
		);

		const fd = await open(this.fileDir);

		await this.root.recursiveParse(fd, 0);
		await fd.close();
		return this;
		// Console.log(this.root.toString());
	}

	async extractBoxBuffer(name: string) {
		const result = this.root.getChild(name);
		const fd = await open(this.fileDir);
		if (result) {
			const value = await fd.read({buffer: Buffer.alloc(result.size), position: result.offset, length: result.size});
			await fd.close();
			return value;
		}

		return null;
	}

	async replaceBox(boxStart: number, boxEnd: number, newAtomBuffer: Buffer, outFile: string) {
		// 先检查outPath合法性
		const fd = await open(this.fileDir);
		// If autoClose, streamAfter will be closed by streamBefore as they share the same fileDescriptor.
		const streamBefore = fd.createReadStream({
			end: boxStart,
			autoClose: false,
		});
		const streamToReplace = new PassThrough().end(newAtomBuffer);
		const streamAfter = fd.createReadStream({
			start: boxEnd,
			autoClose: false,
		});

		try {
			await Promise.all([
				pipeline(streamBefore, createWriteStream(outFile, {start: 0})),
				pipeline(streamToReplace, createWriteStream(outFile, {start: boxStart})),
				pipeline(streamAfter, createWriteStream(outFile, {start: boxStart + newAtomBuffer.length})),
			]);
			streamBefore.close();
			streamAfter.close();
		} catch (err) {
			console.log(`[MP4Tree] Replace Box at ${boxStart} Error: `, err);
		}
	}

	async setTag(outPath: string, tags: {
		track?: string;
		title?: string;
		artist?: string;
		album?: string;
		genre?: string;
		comment?: string;
		desc?: string;
		cover?: string | Buffer;
	}) {
		const extractedBuffer = (await this.extractBoxBuffer('moov'))?.buffer;
		const moovAtom = this.root.getChild('moov') ?? new MP4TreeAtom('moov');
		const boxStart = moovAtom.offset;
		const boxEnd = moovAtom.offset + moovAtom.size;

		// 把moov其他data先存下来
		if (moovAtom && extractedBuffer) {
			moovAtom.parent = undefined;
			let iter: MP4TreeAtom | undefined = moovAtom;
			while (iter) {
				console.log(`${iter.name}: ${iter.offset}, ${iter.size}`);
				if (!iter.getPath().startsWith('moov.udta.meta')) {
					// Should dump
					if (!iter.children.length) {
						iter.data = Buffer.alloc(iter.size - 8);
						extractedBuffer.copy(iter.data, 0, iter.offset + 8 - moovAtom.offset, iter.offset + iter.size - moovAtom.offset);
					}
				}

				iter = iter.hasNext();
			}
		}

		const udtaAtom = moovAtom.getChild('udta') ?? new MP4TreeAtom('udta', moovAtom);

		// Add new meta node
		const metaAtom = new MP4TreeAtom('meta'); // Meta node is added by replaceOrAdd
		metaAtom.padding = 4;
		const hdlr = new MP4TreeAtom('hdlr', metaAtom);
		hdlr.loadMetaDataBuffer(Buffer.from('mdirappl\0\0\0\0\0\0\0\0\0'));
		// Hdlr.updateLeafAtomSize("mdirappl\0\0\0\0\0\0\0\0\0", true);
		metaAtom.addChild(hdlr);

		const ilstAtom = new MP4TreeAtom('ilst', metaAtom);

		if (tags.artist) {
			MP4Tree.createMetaDataAtom('\xA9ART', ilstAtom, tags.artist);
		}

		if (tags.title) {
			MP4Tree.createMetaDataAtom('\xA9nam', ilstAtom, tags.title);
		}

		if (tags.album) {
			MP4Tree.createMetaDataAtom('\xA9alb', ilstAtom, tags.album);
		}

		if (tags.genre) {
			MP4Tree.createMetaDataAtom('\xA9gen', ilstAtom, tags.genre);
		}

		if (tags.comment) {
			MP4Tree.createMetaDataAtom('\xA9cmt', ilstAtom, tags.comment);
		}

		if (tags.desc) {
			MP4Tree.createMetaDataAtom('desc', ilstAtom, tags.desc);
		}

		let trackString = '';

		if (tags.track) {
			// Find track/total

			let [track, total] = tags.track.split('/').map(i => parseInt(i, 10));
			if (typeof track === 'number' && Number.isInteger(track) && track >= 0 && track < 65536) {
				trackString += '\0\0' + track;
				if (!(typeof total === 'number' && Number.isInteger(total) && total >= 0 && total < 65536)) {
					total = 0;
				}

				trackString += total + '\0\0';
				MP4Tree.createMetaDataAtom('\xA9cmt', ilstAtom, trackString);
			} else {
				console.log(`Invalid track number string ${tags.track}, skipped.`);
			}
		}

		let coverBuffer: Buffer | undefined;

		if (tags.cover) {
			if (Buffer.isBuffer(tags.cover)) {
				coverBuffer = tags.cover;
			} else if (typeof tags.cover === 'string') {
				try {
					const coverPath = tags.cover;
					let outBuffer: Buffer;
					coverBuffer = await stat(coverPath).then(
						async stats => {
							// DOTO: STATS ERROR HANDLE
							outBuffer = Buffer.alloc(stats.size);
							return open(coverPath);
						}).then(async fd => fd.read({buffer: outBuffer}),
					).then(
						res => res.buffer,
					);
				} catch (err) {
					console.log(`[MP4Tree ERROR] Failed to read cover ${tags.cover}: ${err}`);
				}
			} else {
				console.log('[MP4Tree ERROR] Failed to read cover: Require path string or Buffer as input.');
			}
		}

		if (trackString) {
			MP4Tree.createMetaDataAtom('trkn', ilstAtom, trackString);
		}

		if (coverBuffer) {
			MP4Tree.createMetaDataAtom('covr', ilstAtom, coverBuffer);
		}

		metaAtom.addChild(ilstAtom);

		metaAtom.updateSizeAndOffset();

		udtaAtom.replaceOrAddChild('meta', metaAtom);
		// UdtaAtom.addChild(metaAtom);
		moovAtom.updateSizeAndOffset();
		// Remount moov
		moovAtom.parent = this.root;

		// Has some problem since moov changed
		const bufferOut = moovAtom.dumpAll();

		// This.replaceBox(moovAtom, moovAtom.dumpAll(), outFile);
		// await outFile.writeFile(bufferOut);
		await this.replaceBox(boxStart, boxEnd, bufferOut, outPath);
	}
}
