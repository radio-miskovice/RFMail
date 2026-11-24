# LZHUF test fixtures

`gettysburg.txt` and `gettysburg.txt.lzh` are copied verbatim from
[la5nTA/wl2k-go](https://github.com/la5nTA/wl2k-go), `lzhuf/testdata/`
(© Martin Hebnes Pedersen, MIT licence; see that repository's `LICENSE`).
`gettysburg.txt.lzh` is the B2-framed LZHUF encoding of `gettysburg.txt`:
`uint16le(crc) || uint32le(1548) || compressed`, 861 bytes in total.

They are used by `test/lzhuf.test.ts` to assert both directions byte for
byte. The larger vectors in that directory (`e.txt`, `pi.txt`, the Mark Twain
text and the recorded `.b2f`) are deliberately not copied here.
