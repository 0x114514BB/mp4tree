/* eslint-disable @typescript-eslint/no-this-alias */
import {type FileHandle} from 'node:fs/promises';
// Nested like a tree.
// eslint-disable-next-line @typescript-eslint/naming-convention
export class MP4TreeAtom {
	// Atoms technically shouldn't have data AND children.
	// but a bunch of them break this rule. This is not
	// handled by this library yet - but this padding variable
	// is for the moov.udta.meta atom, which has a historically
	// different format. See MP4.giveTags for an example.
	// The meta has 4 byte padding 00 00 00 00. ?
	padding = 0;
	size = 0;
	offset = 0;
	children: MP4TreeAtom[] = [];
	root = false;
	name: string;
	// Container has size|name buffer
	data?: Buffer;

	constructor(name: string, public parent?: MP4TreeAtom, offset = 0) {
		if (name === 'root') {
			this.root = true;
			this.offset = offset;
		}

		if (name.length !== 4) {
			throw new Error('MP4TreeAtom must have name length of 4');
		}

		this.name = name;
	}

	hasChild(name: string) {
		return Boolean(this.children.find(child => child.name === name));
	}

	toString(indent = 0) {
		let string = '| '.repeat(indent);

		string += (this.root ? 'MP4:' : this.name);

		// If actual atom data was printed, it would mostly be a mess of binary data.
		if (this.size) {
			string += ' => ' + (this.padding ? this.padding + 'pad' : '') + ' size: ' + this.size + ' offset:' + this.offset;
			this.children.forEach(child => {
				string += '\n' + child.toString(indent + 1);
				return null;
			});
		}

		return string;
	}

	getChild(name: string): MP4TreeAtom | undefined {
		return this.children.find(child => child.name === name);
	}

	// Given a child path, separated by dots, return that child, or recursively create it
	ensureChild(childName: string): MP4TreeAtom {
		const pathArray = childName.split('.');
		const firstChild = pathArray[0]!;

		if (!this.hasChild(firstChild)) {
			this.addChild(firstChild);
		}

		const child = this.getChild(firstChild)!;

		if (pathArray[1]) {
			pathArray.shift();
			return child.ensureChild(pathArray.join('.'));
		}

		return child;
	}

	addChild(node: string | MP4TreeAtom, index?: number) {
		let atom: MP4TreeAtom;
		if (typeof node === 'string') {
			atom = new MP4TreeAtom(node, this);
		} else {
			atom = node;
			atom.parent = this;
		}

		if (index === undefined) {
			this.children.push(atom);
			return atom;
		}

		index = Math.max(index, 0);
		index = Math.min(this.children.length, index);

		this.children.splice(index, 0, atom);
		return atom;
	}

	replaceOrAddChild(name: string, newChild: MP4TreeAtom) {
		const childIndex = this.children.findIndex(child => child.name === name);
		if (childIndex === -1) {
			this.addChild(name);
		} else {
			this.children.splice(childIndex, 1, newChild);
		}

		this.updateSizeAndOffset();
	}

	/*
http://mp4ra.org/#/atoms
class Box(object):
    box_names = {
        #iso bmff box types
        'ftyp' : 'File type',
        'moov' : 'Movie container',
        'moof' : 'Movie fragment',
        'mfra' : 'Movie fragment random access',
        'mfhd' : 'Movie fragment header',
        'traf' : 'Track fragment',
        'tfhd' : 'Track fragment header',
        'trun' : 'Track fragment run',
        'saiz' : 'Sample auxiliary information sizes',
        'saio' : 'Sample auxiliary information offsets',
        'tfdt' : 'Track fragment decode time',
        'trak' : 'Track container',
        'mdia' : 'Media container',
        'minf' : 'Media information box',
        'dinf' : 'Data information box',
        'vmhd' : 'Video media header',
        'smhd' : 'Sound media header',
        'hmhd' : 'hint media header',
        'mvhd' : 'Movie header',
        'tkhd' : 'Track header',
        'mdhd' : 'Media header',
        'stbl' : 'Sample table',
        'hdlr' : 'Handler box',
        'stsd' : 'Sample description',
        'dref' : 'Data reference box',
        'url ' : 'Data entry URL box',
        'stts' : 'Time-to-sample box',
        'stsc' : 'Sample-to-chunk box',
        'stco' : 'Chunk offset box',
        'stss' : 'Sync sample box',
        'stsz' : 'Sample size box',
        'stz2' : 'Compact sample size box',
        'mvex' : 'Movie extends box',
        'mehd' : 'Movie extends header box',
        'trex' : 'Track extends defaults',
        'udta' : 'User data',
        'skip' : 'Skip',
        'free' : 'Free',
        'mdat' : 'Media data container',
        'styp' : 'Segment type',
        'sidx' : 'Segment index',
        'ssix' : 'Subsegment index',
        'sbgp' : 'Sample to group box',
        'sgpd' : 'Sample group description box',
        'elst' : 'Edit list',
        'colr' : 'Colour information',
        'ctts' : 'Composition offset',
        #common encryption boxes
        'tenc' : 'Track encryption box',
        'senc' : 'Sample encryption box',
        'pssh' : 'Protection system specific header box',
        'schm' : 'Scheme type box',
        'schi' : 'Scheme information box',
        'sinf' : 'Protection scheme information box',
        'frma' : 'Original format box',
    }
    container_boxes = [
        'moov', 'trak', 'edts', 'mdia', 'minf', 'dinf', 'stbl', 'mvex',
        'moof', 'traf', 'mfra', 'skip', 'meta', 'ipro', 'sinf', 'schi',
    ]

    # Avoid printing parsing errors for known data boxes
    data_boxes = ['mdat', 'udta']

*/
	async recursiveParse(fd: FileHandle, position: number) {
		const boxHead = Buffer.alloc(8);
		let boxSize = 0;
		let boxName = '';

		while (position - this.offset < this.size) {
			// eslint-disable-next-line no-await-in-loop
			await fd.read(boxHead, 0, 8, position);

			boxSize = boxHead.readUint32BE(0);
			// Binary is an alias of 'latin1', which only accepts 0x00 - 0xFF
			boxName = boxHead.toString('binary', 4);

			// This way to judge children is too coarse. Issue: sbgp roll error
			if ((/[\xA9\w]{4}/.exec(boxName)) && boxSize <= this.size && boxSize >= 8) {
				const child = new MP4TreeAtom(boxName, this);
				child.size = boxSize;
				if (child.name === 'meta') {
					child.padding = 4;
				}

				child.offset = position;
				this.children.push(child);
				// eslint-disable-next-line no-await-in-loop
				position = await child.recursiveParse(fd, position + 8 + child.padding);
			} else {
				break;
			}
		}

		return this.offset + this.size;
	}

	// When data has size but
	updateSizeAndOffset(offset: number = this.offset) {
		let size = 0;
		this.offset = offset;
		let position = offset + 8 + this.padding;
		this.children.forEach(child => {
			const childSize = child.updateSizeAndOffset(position);
			size += childSize;
			position += childSize;
		});
		if (this.children.length) {
			this.size = size + 8 + this.padding;
		} else {
			this.size = (this.data?.length ?? 0) + 8;
			size = this.size;
		}

		return this.size;
	}

	updateLeafAtomSize(content: string | Buffer, isMetaData = false) {
		if (this.children.length !== 0) {
			console.log('Only leaf node are allowed to load data.');
		} else if (Buffer.isBuffer(content)) {
			this.size = Buffer.isBuffer(content) ? 8 + content.length : 0;
		} else {
			// Text metadata has a limit of 255 bytes(UTF-8)
			this.size = (typeof content === 'string') ? 8 + (Math.min(255, content.length)) : 0;
		}

		if (isMetaData) {
			// Meta data header clas|0000
			this.size += 8;
		}

		return this.size;
	}

	dumpString(buffer: Buffer, source: string, position: number) {
		//  - size|TAGS|
		//      - size|data|cla1|0000|DATA

		buffer.writeInt32BE(this.size, position);
		buffer.write(this.name, position + 4, 'binary');
		buffer.writeInt32BE(1, position + 8);
		buffer.writeInt32BE(0, position + 12);
		return buffer.write(source, position + 16, 'utf8');
	}

	/*
        Discussion about Class/Flag of covr:
        Android's mp4v2 simply set class = 0
        https://android.googlesource.com/platform/external/mp4v2/+/refs/heads/master/src/mp4meta.cpp
        atomicparsley regards 13 as jpeg, 14 as png.
        https://atomicparsley.sourceforge.net/mpeg-4files.html
        Bento4 regards 13 as gif, 14 as jpeg.
        https://github.com/axiomatic-systems/Bento4/blob/master/Source/C%2B%2B/MetaData/Ap4MetaData.h#L469

        I treat cover input as binary data. Hence I will simply set the Class/Flag to 0.
        I Don't know how this value affects media players' cover extraction.

		Update: Bento4 is right. This flag can be resolved by ffprobe.
    */

	dumpBuffer(buffer: Buffer, source: Buffer, position: number) {
		//  - size|covr|
		//      - size|data|cl13|0000|DATA*n // 24+n
		buffer.writeInt32BE(this.size, position);
		buffer.write(this.name, position + 4, 'binary');
		buffer.writeInt32BE(0, position + 8); // 13?
		buffer.writeInt32BE(0, position + 12);
		return source.copy(buffer, position + 16);
	}

	dumpContainer(buffer: Buffer, position: number) {
		buffer.writeInt32BE(this.size, position);
		return buffer.write(this.name, position + 4, 'binary');
	}

	dumpData(buffer: Buffer, position: number) {
		buffer.writeInt32BE(this.size, position);
		buffer.write(this.name, position + 4, 'binary');
		position = position + 8 + this.padding;
		return this.data ? position + this.data.copy(buffer, position) : position;
	}

	dumpAll() {
		const buffer = Buffer.alloc(this.size);
		let position = 0;
		let node: MP4TreeAtom | undefined = this;
		while (position < this.size) {
			position = node?.dumpData(buffer, position) ?? Number.POSITIVE_INFINITY;
			node = node?.hasNext();
		}

		return buffer;
	}

	// String length limit is required.
	// actually metadata string lenght are not strictly limited under 255 bytes？
	loadMetaDataString(source: string) {
		this.data = Buffer.from(('\0\0\0\x01\0\0\0\0' + source).slice(0, 255 + 8), 'utf8');
		this.size = this.data.length;
		return this;
	}

	loadMetaDataBuffer(source: Buffer) {
		this.data = Buffer.alloc(source.length + 8);
		// "\0\0\0\0\0\0\0\0" + source
		this.size = source.copy(this.data, 8) + 8; // 4 from 0000 4 from clas
	}

	loadMetaDataJpeg(source: Buffer) {
		this.data = Buffer.alloc(source.length + 8);
		// "\0\0\0\0\0\0\0\0" + source
		// JPEG 14
		this.data.writeInt32BE(14);
		this.size = source.copy(this.data, 8) + 8; // 4 from 0000 4 from clas
	}

	loadDataBuffer(source: Buffer) {
		this.data = Buffer.from(source);
	}

	copyDataBuffer(source: Buffer) {
		this.data = Buffer.alloc(source.length);
		source.copy(this.data);
	}

	hasNext(rewind = false): MP4TreeAtom | undefined {
		if (!rewind && this.children.length) {
			return this.children[0];
		}

		if (this.parent) {
			const childs = this.parent.children;
			const index = childs.indexOf(this);
			if (index < childs.length - 1) {
				return childs.at(index + 1);
			}

			return this.parent.hasNext(true); // && return last one
		}

		return undefined;
	}

	// Attention: there are different box with same path.
	getPath(): string {
		return this.parent ? `${this.parent.getPath()}.${this.name}` : this.name;
	}

	//
}
