// LZHUF, in the Winlink "B2" variant used by FBB forwarding.
//
// The algorithm is Haruyasu Yoshizaki's LZHUF as carried through JNOS and
// F6FBB; this is a port of wl2k-go's `lzhuf` package (Martin Hebnes Pedersen,
// LA5NTA, MIT) so the bit stream is byte-identical to the one Winlink peers
// and Airmail exchange. Do not "improve" it: a different tree, a different
// tie-break, or a different bit order produces mail no peer can read.
//
// Two framings are implemented:
//
//   LZHUF:  uint32le(uncompressedSize) || compressed
//   B2:     uint16le(crc) || uint32le(uncompressedSize) || compressed
//
// `crc` is XMODEM CRC-CCITT (init 0, no reflection, two trailing zero bytes
// folded in) over `uint32le(uncompressedSize) || compressed`, per R4.2.2.
// A stream without the size header cannot be decoded, so "raw LZHUF" here
// means the non-CRC framing above — what wl2k-go's `NewWriter(w, false)`
// writes — and B2 adds only the leading checksum.

const N = 2048; // ring buffer size
const F = 60; // look-ahead buffer size
const NIL = N; // leaf of tree
const THRESHOLD = 2;
const N_CHAR = 256 - THRESHOLD + F; // kinds of characters (code = 0..N_CHAR-1)
const T = N_CHAR * 2 - 1; // size of the Huffman table
const R = T - 1; // position of the root
const MAX_FREQ = 0x8000; // update tree when a frequency reaches this
const FREQ_LEN = T + 1; // freq[] length in the reference (`[_T + 1]uint`)

// Encoding tables for the upper 6 bits of a match position.
const P_CODE = new Uint8Array([
	0x00, 0x20, 0x30, 0x40,
	0x50, 0x58, 0x60, 0x68,
	0x70, 0x78, 0x80, 0x88,
	0x90, 0x94, 0x98, 0x9c,
	0xa0, 0xa4, 0xa8, 0xac,
	0xb0, 0xb4, 0xb8, 0xbc,
	0xc0, 0xc2, 0xc4, 0xc6,
	0xc8, 0xca, 0xcc, 0xce,
	0xd0, 0xd2, 0xd4, 0xd6,
	0xd8, 0xda, 0xdc, 0xde,
	0xe0, 0xe2, 0xe4, 0xe6,
	0xe8, 0xea, 0xec, 0xee,
	0xf0, 0xf1, 0xf2, 0xf3,
	0xf4, 0xf5, 0xf6, 0xf7,
	0xf8, 0xf9, 0xfa, 0xfb,
	0xfc, 0xfd, 0xfe, 0xff,
]);

const P_LEN = new Uint8Array([
	0x03, 0x04, 0x04, 0x04,
	0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05,
	0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06,
	0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07,
	0x08, 0x08, 0x08, 0x08,
	0x08, 0x08, 0x08, 0x08,
	0x08, 0x08, 0x08, 0x08,
	0x08, 0x08, 0x08, 0x08,
]);

// Decoding tables for the same 6 bits, indexed by the next 8 bits of input.
const D_CODE = new Uint8Array([
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
	0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
	0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
	0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
	0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
	0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
	0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a,
	0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b,
	0x0c, 0x0c, 0x0c, 0x0c, 0x0d, 0x0d, 0x0d, 0x0d,
	0x0e, 0x0e, 0x0e, 0x0e, 0x0f, 0x0f, 0x0f, 0x0f,
	0x10, 0x10, 0x10, 0x10, 0x11, 0x11, 0x11, 0x11,
	0x12, 0x12, 0x12, 0x12, 0x13, 0x13, 0x13, 0x13,
	0x14, 0x14, 0x14, 0x14, 0x15, 0x15, 0x15, 0x15,
	0x16, 0x16, 0x16, 0x16, 0x17, 0x17, 0x17, 0x17,
	0x18, 0x18, 0x19, 0x19, 0x1a, 0x1a, 0x1b, 0x1b,
	0x1c, 0x1c, 0x1d, 0x1d, 0x1e, 0x1e, 0x1f, 0x1f,
	0x20, 0x20, 0x21, 0x21, 0x22, 0x22, 0x23, 0x23,
	0x24, 0x24, 0x25, 0x25, 0x26, 0x26, 0x27, 0x27,
	0x28, 0x28, 0x29, 0x29, 0x2a, 0x2a, 0x2b, 0x2b,
	0x2c, 0x2c, 0x2d, 0x2d, 0x2e, 0x2e, 0x2f, 0x2f,
	0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
	0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
]);

const D_LEN = new Uint8Array([
	0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
	0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
	0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08,
]);

// XMODEM CRC-CCITT table (Airmail/Winlink's variant), from wl2k-go's crc.go.
const CRC16_TAB = new Uint16Array([
	0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
	0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
	0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
	0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
	0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
	0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
	0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
	0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
	0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
	0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
	0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
	0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
	0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
	0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
	0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
	0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
	0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
	0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
	0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
	0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
	0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
	0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
	0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
	0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
	0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
	0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
	0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
	0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
	0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
	0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
	0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
	0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0,
]);

/**
 * XMODEM CRC-CCITT as Winlink uses it: initial value 0, no input/output
 * reflection, and two zero bytes folded in at the end.
 */
export function crc16(data: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < data.length; i++) {
		sum = crcByte(data[i]!, sum);
	}
	sum = crcByte(0, sum);
	sum = crcByte(0, sum);
	return sum & 0xffff;
}

function crcByte(byte: number, sum: number): number {
	return (((sum << 8) & 0xff00) ^ CRC16_TAB[(sum >>> 8) & 0xff]! ^ byte) & 0xffff;
}

// --- tree -------------------------------------------------------------------

interface LzhufTree {
	/** Frequencies of the Huffman nodes, plus a sentinel at T. */
	freq: Uint32Array;
	/** Parent pointers, with the leaves' codes at [T .. T+N_CHAR-1]. */
	prnt: Int32Array;
	/** Child pointers of the Huffman nodes. */
	son: Int32Array;
	/** The match tree over textBuf positions: parent, children. */
	dad: Int32Array;
	lson: Int32Array;
	rson: Int32Array;
	/** Ring buffer plus its wrap-around duplicate. */
	textBuf: Uint8Array;
	matchLength: number;
	matchPosition: number;
}

function newTree(): LzhufTree {
	const tree: LzhufTree = {
		freq: new Uint32Array(FREQ_LEN),
		prnt: new Int32Array(T + N_CHAR),
		son: new Int32Array(T),
		dad: new Int32Array(N + 1),
		lson: new Int32Array(N + 1),
		rson: new Int32Array(N + 257),
		textBuf: new Uint8Array(N + F - 1),
		matchLength: 0,
		matchPosition: 0,
	};

	for (let i = 0; i < N_CHAR; i++) {
		tree.freq[i] = 1;
		tree.son[i] = i + T;
		tree.prnt[i + T] = i;
	}
	for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) {
		tree.freq[j] = tree.freq[i]! + tree.freq[i + 1]!;
		tree.son[j] = i;
		tree.prnt[i] = j;
		tree.prnt[i + 1] = j;
	}
	tree.freq[T] = 0xffff;
	tree.prnt[R] = 0;

	return tree;
}

function initTree(tree: LzhufTree): void {
	for (let i = N + 1; i <= N + 256; i++) {
		tree.rson[i] = NIL; // root
	}
	for (let i = 0; i < N; i++) {
		tree.dad[i] = NIL; // node
	}
}

function deleteNode(tree: LzhufTree, p: number): void {
	if (tree.dad[p] === NIL) {
		return; // not registered
	}

	let q: number;
	if (tree.rson[p] === NIL) {
		q = tree.lson[p]!;
	} else if (tree.lson[p] === NIL) {
		q = tree.rson[p]!;
	} else {
		q = tree.lson[p]!;
		if (tree.rson[q] !== NIL) {
			while (tree.rson[q] !== NIL) {
				q = tree.rson[q]!;
			}
			tree.rson[tree.dad[q]!] = tree.lson[q]!;
			tree.dad[tree.lson[q]!] = tree.dad[q]!;
			tree.lson[q] = tree.lson[p]!;
			tree.dad[tree.lson[p]!] = q;
		}
		tree.rson[q] = tree.rson[p]!;
		tree.dad[tree.rson[p]!] = q;
	}

	tree.dad[q] = tree.dad[p]!;
	if (tree.rson[tree.dad[p]!] === p) {
		tree.rson[tree.dad[p]!] = q;
	} else {
		tree.lson[tree.dad[p]!] = q;
	}

	tree.dad[p] = NIL;
}

function insertNode(tree: LzhufTree, r: number): void {
	const text = tree.textBuf;
	let p = N + 1 + text[r]!;
	let cmp = 1;
	tree.rson[r] = NIL;
	tree.lson[r] = NIL;
	tree.matchLength = 0;

	for (;;) {
		if (cmp >= 0) {
			if (tree.rson[p] !== NIL) {
				p = tree.rson[p]!;
			} else {
				tree.rson[p] = r;
				tree.dad[r] = p;
				return;
			}
		} else if (tree.lson[p] !== NIL) {
			p = tree.lson[p]!;
		} else {
			tree.lson[p] = r;
			tree.dad[r] = p;
			return;
		}

		let i = 1;
		for (; i < F; i++) {
			cmp = text[r + i]! - text[p + i]!;
			if (cmp !== 0) {
				break;
			}
		}
		if (i > THRESHOLD) {
			if (i > tree.matchLength) {
				tree.matchPosition = ((r - p) & (N - 1)) - 1;
				tree.matchLength = i;
				if (tree.matchLength >= F) {
					break;
				}
			}
			if (i === tree.matchLength) {
				const c = ((r - p) & (N - 1)) - 1;
				if (c < tree.matchPosition) {
					tree.matchPosition = c;
				}
			}
		}
	}

	// Match of length F found: replace p by r.
	tree.dad[r] = tree.dad[p]!;
	tree.lson[r] = tree.lson[p]!;
	tree.rson[r] = tree.rson[p]!;
	tree.dad[tree.lson[p]!] = r;
	tree.dad[tree.rson[p]!] = r;
	if (tree.rson[tree.dad[p]!] === p) {
		tree.rson[tree.dad[p]!] = r;
	} else {
		tree.lson[tree.dad[p]!] = r;
	}
	tree.dad[p] = NIL; // remove p
}

function reconst(tree: LzhufTree): void {
	const freq = tree.freq;
	const son = tree.son;

	// Collect leaf nodes in the first half of the table and halve the
	// frequencies.
	for (let i = 0, j = 0; i < T; i++) {
		if (son[i]! >= T) {
			freq[j] = Math.floor((freq[i]! + 1) / 2);
			son[j] = son[i]!;
			j++;
		}
	}

	// Rebuild by connecting the children, keeping the table sorted by
	// frequency.
	for (let i = 0, j = N_CHAR; j < T; i += 2, j++) {
		freq[j] = freq[i]! + freq[i + 1]!;

		const first = freq[j]!;
		let k = j;
		while (first < freq[k - 1]!) {
			k--;
		}

		const last = j - k; // number of elements to move right

		freq.copyWithin(k + 1, k, k + last);
		freq[k] = first;

		son.copyWithin(k + 1, k, k + last);
		son[k] = i;
	}

	// Connect the parents.
	for (let i = 0; i < T; i++) {
		const k = son[i]!;
		if (k >= T) {
			tree.prnt[k] = i;
		} else {
			tree.prnt[k + 1] = i;
			tree.prnt[k] = i;
		}
	}
}

function update(tree: LzhufTree, c0: number): void {
	const freq = tree.freq;
	const prnt = tree.prnt;
	const son = tree.son;

	if (freq[R] === MAX_FREQ) {
		reconst(tree);
	}

	// Swap nodes to keep the tree frequency-ordered.
	let c = prnt[c0 + T]!;
	for (;;) {
		freq[c] = freq[c]! + 1;

		if (freq[c]! <= freq[c + 1]! || FREQ_LEN <= c + 2) {
			c = prnt[c]!;
			if (c === 0) {
				break;
			}
			continue; // order is ok
		}

		let l = c + 1;
		const k = freq[c]!;
		while (k > freq[l + 1]!) {
			l++;
		}

		freq[c] = freq[l]!;
		freq[l] = k;

		let i = son[c]!;
		prnt[i] = l;
		if (i < T) {
			prnt[i + 1] = l;
		}

		const j = son[l]!;
		son[l] = i;

		prnt[j] = c;
		if (j < T) {
			prnt[j + 1] = c;
		}
		son[c] = j;

		c = prnt[l]!;
		if (c === 0) {
			break;
		}
	}
}

// --- byte sinks -------------------------------------------------------------

interface Sink {
	buf: Uint8Array;
	len: number;
}

function newSink(capacity: number): Sink {
	return { buf: new Uint8Array(Math.max(16, capacity)), len: 0 };
}

function sinkPush(sink: Sink, byte: number): void {
	if (sink.len === sink.buf.length) {
		const grown = new Uint8Array(sink.buf.length * 2);
		grown.set(sink.buf);
		sink.buf = grown;
	}
	sink.buf[sink.len] = byte;
	sink.len++;
}

function sinkBytes(sink: Sink): Uint8Array {
	return sink.buf.slice(0, sink.len);
}

// --- encoder ----------------------------------------------------------------

interface Compressor {
	tree: LzhufTree;
	out: Sink;
	/** Bits waiting to be written, in the high part of the word. */
	putbuf: number;
	/** Number of pending bits. */
	putlen: number;
	r: number;
	s: number;
	len: number;
	lastMatchLength: number;
	preFilled: boolean;
}

function putCode(c: Compressor, l: number, code: number): void {
	// The reference keeps `putbuf` in a machine word and lets the bits that
	// were already emitted wrap out of it; only the low 32 bits are ever read,
	// so mask with `>>> 0` to reproduce that wrap instead of letting a double
	// grow past the point where its low bits are exact.
	c.putbuf = (c.putbuf + (code >>> c.putlen)) >>> 0;
	c.putlen += l;

	if (c.putlen < 8) {
		return;
	}

	sinkPush(c.out, (c.putbuf >>> 8) & 0xff);
	c.putlen -= 8;

	if (c.putlen >= 8) {
		sinkPush(c.out, c.putbuf & 0xff);

		c.putlen -= 8;
		c.putbuf = (code * 2 ** (l - c.putlen)) >>> 0;
	} else {
		c.putbuf = (c.putbuf * 0x100) >>> 0;
	}
}

function encodeChar(c: Compressor, ch: number): void {
	// Travel from the leaf to the root.
	let i = 0;
	let j = 0;
	let k = c.tree.prnt[ch + T]!;
	for (;;) {
		i = Math.floor(i / 2);
		j++;

		// If the node's address is odd-numbered, take the bigger brother.
		if ((k & 1) !== 0) {
			i += 0x8000;
		}

		k = c.tree.prnt[k]!;
		if (k === R) {
			break;
		}
	}
	putCode(c, j, i);
	update(c.tree, ch);
}

function encodePosition(c: Compressor, position: number): void {
	// Upper 6 bits by table lookup.
	const i = position >>> 6;
	putCode(c, P_LEN[i]!, P_CODE[i]! << 8);

	// Lower 6 bits verbatim.
	putCode(c, 6, (position & 0x3f) << 10);
}

function encode(c: Compressor): void {
	if (c.len === 0) {
		return;
	}

	// Encode from the look-ahead buffer.
	if (c.tree.matchLength > c.len) {
		c.tree.matchLength = c.len;
	}

	if (c.tree.matchLength <= THRESHOLD) {
		c.tree.matchLength = 1;
		encodeChar(c, c.tree.textBuf[c.r]!);
	} else {
		encodeChar(c, 255 - THRESHOLD + c.tree.matchLength);
		encodePosition(c, c.tree.matchPosition);
	}

	c.lastMatchLength = c.tree.matchLength;
}

function advance(c: Compressor, byte: number): void {
	if (byte !== -1) {
		// Add to the look-ahead buffer.
		c.tree.textBuf[c.s] = byte;
		if (c.s < F - 1) {
			c.tree.textBuf[c.s + N] = byte;
		}
		c.len++;
	}

	// Process one byte from the look-ahead buffer.
	insertNode(c.tree, c.r);
	c.lastMatchLength--;
	if (c.lastMatchLength === 0) {
		encode(c);
	}
	deleteNode(c.tree, c.s);
	c.s = (c.s + 1) & (N - 1);
	c.r = (c.r + 1) & (N - 1);
	c.len--;
}

function encodeStream(data: Uint8Array): Uint8Array {
	const tree = newTree();
	initTree(tree);

	for (let i = 0; i < N - F; i++) {
		tree.textBuf[i] = 0x20; // the reference pre-fills with spaces
	}

	const c: Compressor = {
		tree,
		out: newSink(data.length > 0 ? data.length : 16),
		putbuf: 0,
		putlen: 0,
		r: N - F,
		s: 0,
		len: 0,
		lastMatchLength: 0,
		preFilled: false,
	};

	let n = 0;
	// Pre-fill the look-ahead buffer.
	while (!c.preFilled && n < data.length) {
		tree.textBuf[c.r + c.len] = data[n]!;
		n++;
		c.len++;
		insertNode(tree, c.r - c.len);

		c.lastMatchLength = 1;
		c.preFilled = c.len === F;
	}

	while (n < data.length) {
		advance(c, data[n]!);
		n++;
	}

	// Flush the look-ahead buffer.
	while (c.len > 0) {
		advance(c, -1);
	}
	encode(c);

	if (c.putlen !== 0) {
		sinkPush(c.out, Math.floor(c.putbuf / 0x100) % 0x100);
	}

	return sinkBytes(c.out);
}

// --- decoder ----------------------------------------------------------------

interface BitInput {
	data: Uint8Array;
	pos: number;
	buf: number;
	count: number;
}

function readBits(input: BitInput, bits: number): number {
	while (bits > input.count) {
		const byte = input.data[input.pos];
		if (byte === undefined) {
			throw new Error('lzhuf: truncated stream: bit reader ran past the end of the data');
		}
		input.pos++;
		input.buf = ((input.buf << 8) | byte) & 0xffff;
		input.count += 8;
	}
	const value = (input.buf >>> (input.count - bits)) & ((1 << bits) - 1);
	input.count -= bits;
	return value;
}

function decodeChar(tree: LzhufTree, input: BitInput): number {
	let c = tree.son[R]!;

	// Travel from the root to a leaf: son[] if the bit is 0, son[]+1 if 1.
	while (c < T) {
		c += readBits(input, 1);
		c = tree.son[c]!;
	}
	c -= T;
	update(tree, c);
	return c;
}

function decodePosition(input: BitInput): number {
	// Recover the upper 6 bits by table lookup.
	let i = readBits(input, 8);
	const c = D_CODE[i]! << 6;
	let j = D_LEN[i]!;

	// Read the lower 6 bits verbatim.
	for (j -= 2; j > 0; j--) {
		i = (((i << 1) + readBits(input, 1)) & 0xff);
	}
	return c | (i & 0x3f);
}

function decodeStream(compressed: Uint8Array, size: number): Uint8Array {
	const tree = newTree();
	for (let i = 0; i < N - F; i++) {
		tree.textBuf[i] = 0x20;
	}

	const input: BitInput = { data: compressed, pos: 0, buf: 0, count: 0 };
	const out = newSink(Math.min(Math.max(size, 16), 0x100000));
	let r = N - R;
	let pos = 0;

	while (pos < size) {
		const c = decodeChar(tree, input);

		if (c < 256) {
			sinkPush(out, c);
			tree.textBuf[r] = c;
			r = (r + 1) & (N - 1);
			pos++;
			continue;
		}

		const from = (r - decodePosition(input) - 1) & (N - 1);
		const count = c - 255 + THRESHOLD;
		for (let k = 0; k < count; k++) {
			if (pos === size) {
				throw new Error(
					`lzhuf: stream decodes to more than the declared ${size} bytes`,
				);
			}
			const byte = tree.textBuf[(from + k) & (N - 1)]!;
			sinkPush(out, byte);
			tree.textBuf[r] = byte;
			r = (r + 1) & (N - 1);
			pos++;
		}
	}

	return sinkBytes(out);
}

// --- framing ----------------------------------------------------------------

function writeUint32LE(out: Uint8Array, offset: number, value: number): void {
	out[offset] = value & 0xff;
	out[offset + 1] = (value >>> 8) & 0xff;
	out[offset + 2] = (value >>> 16) & 0xff;
	out[offset + 3] = Math.floor(value / 0x1000000) & 0xff;
}

function readUint32LE(data: Uint8Array, offset: number): number {
	return (
		data[offset]! |
		(data[offset + 1]! << 8) |
		(data[offset + 2]! << 16)
	) + data[offset + 3]! * 0x1000000;
}

function readUint16LE(data: Uint8Array, offset: number): number {
	return data[offset]! | (data[offset + 1]! << 8);
}

/**
 * Compresses `data` to a plain LZHUF stream: `uint32le(size) || compressed`.
 */
export function compressLzhuf(data: Uint8Array): Uint8Array {
	const compressed = encodeStream(data);
	const out = new Uint8Array(4 + compressed.length);
	writeUint32LE(out, 0, data.length);
	out.set(compressed, 4);
	return out;
}

/**
 * Decompresses a plain LZHUF stream written by {@link compressLzhuf}.
 */
export function decompressLzhuf(data: Uint8Array): Uint8Array {
	if (data.length < 4) {
		throw new Error('lzhuf: truncated stream: shorter than the 4-byte size header');
	}
	const size = readUint32LE(data, 0);
	return decodeStream(data.subarray(4), size);
}

/**
 * Compresses `data` to the B2 framing Winlink peers expect:
 * `uint16le(crc) || uint32le(size) || compressed`.
 */
export function compressB2(data: Uint8Array): Uint8Array {
	const compressed = encodeStream(data);

	const checksummed = new Uint8Array(4 + compressed.length);
	writeUint32LE(checksummed, 0, data.length);
	checksummed.set(compressed, 4);
	const sum = crc16(checksummed);

	const out = new Uint8Array(6 + compressed.length);
	out[0] = sum & 0xff;
	out[1] = (sum >>> 8) & 0xff;
	out.set(checksummed, 2);
	return out;
}

/**
 * Decompresses a B2 stream, verifying the checksum and the declared length.
 */
export function decompressB2(data: Uint8Array): Uint8Array {
	if (data.length < 6) {
		throw new Error('lzhuf: truncated stream: shorter than the 6-byte B2 header');
	}

	const sum = readUint16LE(data, 0);
	const size = readUint32LE(data, 2);

	// Decode first, so a stream that simply ends early is reported as
	// truncated rather than as a checksum failure.
	const decoded = decodeStream(data.subarray(6), size);

	// The checksum covers the size field as it stands in the stream followed by
	// the compressed bytes, so the raw bytes from offset 2 are exactly what it
	// was computed over.
	const actual = crc16(data.subarray(2));
	if (actual !== sum) {
		throw new Error(
			`lzhuf: checksum mismatch: B2 header holds 0x${sum.toString(16).padStart(4, '0')}, ` +
				`data gives 0x${actual.toString(16).padStart(4, '0')}`,
		);
	}

	return decoded;
}
