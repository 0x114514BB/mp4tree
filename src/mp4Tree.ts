/* eslint-disable complexity */
import {MP4TreeNode} from './MP4TreeNode';
import {open, stat} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {PassThrough} from 'node:stream';
import {pipeline} from 'stream/promises';

// eslint-disable-next-line @typescript-eslint/naming-convention
export class MP4Tree {
	// MP4Tree
	static createMetaDataNode = (name: string, ilst: MP4TreeNode, content: string | Buffer) => {
		const nodeAtom = new MP4TreeNode(name, ilst);
		const dataAtom = new MP4TreeNode('data', nodeAtom);
		if (Buffer.isBuffer(content)) {
			dataAtom.loadMetaDataBuffer(content);
		} else {
			dataAtom.loadMetaDataString(content);
		}

		nodeAtom.addChild(dataAtom);
		ilst.addChild(nodeAtom);
		return nodeAtom;
	};

	isValid = false;
	fileDir: string;
	root: MP4TreeNode;
	size = -1;

	constructor(input: string) {
		this.fileDir = input;
		// First thing to do is establish the root Atom - but from then on this can all be recursive.
		this.root = new MP4TreeNode('root');

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

		// Console.log(this.root.toString());
	}

	async extractBoxBuffer(name: string) {
		const result = this.root.getChild(name);
		const fd = await open(this.fileDir);
		if (result) {
			return fd.read({buffer: Buffer.alloc(result.size), position: result.offset, length: result.size});
		}

		return null;
	}

	async replaceBox(boxStart: number, boxEnd: number, newNodeBuffer: Buffer, outFile: string) {
		// 先检查outPath合法性
		const fd = await open(this.fileDir);
		// If autoClose, streamAfter will be closed by streamBefore as they share the same fileDescriptor.
		const streamBefore = fd.createReadStream({
			end: boxStart,
			autoClose: false,
		});
		const streamToReplace = new PassThrough().end(newNodeBuffer);
		const streamAfter = fd.createReadStream({
			start: boxEnd,
			autoClose: false,
		});

		try {
			await Promise.all([
				pipeline(streamBefore, createWriteStream(outFile, {start: 0})),
				pipeline(streamToReplace, createWriteStream(outFile, {start: boxStart})),
				pipeline(streamAfter, createWriteStream(outFile, {start: boxStart + newNodeBuffer.length})),
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
		const moovNode = this.root.getChild('moov') ?? new MP4TreeNode('moov');
		const boxStart = moovNode.offset;
		const boxEnd = moovNode.offset + moovNode.size;

		// 把moov其他data先存下来
		if (moovNode && extractedBuffer) {
			moovNode.parent = undefined;
			let iter: MP4TreeNode | undefined = moovNode;
			while (iter) {
				console.log(`${iter.name}: ${iter.offset}, ${iter.size}`);
				if (!iter.getPath().startsWith('moov.udta.meta')) {
					// Should dump
					if (!iter.children.length) {
						iter.data = Buffer.alloc(iter.size - 8);
						extractedBuffer.copy(iter.data, 0, iter.offset + 8 - moovNode.offset, iter.offset + iter.size - moovNode.offset);
					}
				}

				iter = iter.hasNext();
			}
		}

		const udtaNode = moovNode.getChild('udta') ?? new MP4TreeNode('udta', moovNode);

		// Add new meta node
		const metaNode = new MP4TreeNode('meta'); // Meta node is added by replaceOrAdd
		metaNode.padding = 4;
		const hdlr = new MP4TreeNode('hdlr', metaNode);
		hdlr.loadMetaDataBuffer(Buffer.from('mdirappl\0\0\0\0\0\0\0\0\0'));
		// Hdlr.updateLeafNodeSize("mdirappl\0\0\0\0\0\0\0\0\0", true);
		metaNode.addChild(hdlr);

		const ilstNode = new MP4TreeNode('ilst', metaNode);

		if (tags.artist) {
			MP4Tree.createMetaDataNode('\xA9ART', ilstNode, tags.artist);
		}

		if (tags.title) {
			MP4Tree.createMetaDataNode('\xA9nam', ilstNode, tags.title);
		}

		if (tags.album) {
			MP4Tree.createMetaDataNode('\xA9alb', ilstNode, tags.album);
		}

		if (tags.genre) {
			MP4Tree.createMetaDataNode('\xA9gen', ilstNode, tags.genre);
		}

		if (tags.comment) {
			MP4Tree.createMetaDataNode('\xA9cmt', ilstNode, tags.comment);
		}

		if (tags.desc) {
			MP4Tree.createMetaDataNode('desc', ilstNode, tags.desc);
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
				MP4Tree.createMetaDataNode('\xA9cmt', ilstNode, trackString);
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
			MP4Tree.createMetaDataNode('trkn', ilstNode, trackString);
		}

		if (coverBuffer) {
			MP4Tree.createMetaDataNode('covr', ilstNode, coverBuffer);
		}

		metaNode.addChild(ilstNode);

		metaNode.updateSizeAndOffset();

		udtaNode.replaceOrAddChild('meta', metaNode);
		// UdtaNode.addChild(metaNode);
		moovNode.updateSizeAndOffset();
		// Remount moov
		moovNode.parent = this.root;

		// Has some problem since moov changed
		const bufferOut = moovNode.dumpAll();

		// This.replaceBox(moovNode, moovNode.dumpAll(), outFile);
		// await outFile.writeFile(bufferOut);
		await this.replaceBox(boxStart, boxEnd, bufferOut, outPath);
	}
}
