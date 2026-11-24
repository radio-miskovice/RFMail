// Server-side HTML sanitisation for message bodies.
//
// Winlink and internet mail both carry arbitrary HTML. It is sanitised on read
// (not on storage) so a stricter rule applies retroactively to old mail.
// Images keep their source in data-src but are not loaded until the reader asks,
// which keeps a tracking pixel from reporting that the mail was opened.

import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
	'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'div', 'dl', 'dt',
	'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre',
	's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot',
	'th', 'thead', 'tr', 'u', 'ul',
];

export function sanitiseHtml(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: ALLOWED_TAGS,
		allowedAttributes: {
			a: ['href', 'title', 'rel', 'target'],
			img: ['src', 'data-src', 'alt', 'width', 'height'],
			td: ['colspan', 'rowspan'],
			th: ['colspan', 'rowspan'],
			table: ['border', 'cellpadding', 'cellspacing'],
			'*': ['dir', 'lang'],
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		allowProtocolRelative: false,
		disallowedTagsMode: 'discard',
		transformTags: {
			a: (tagName, attribs) => ({
				tagName,
				attribs: {
					...attribs,
					...(attribs['href'] ? { href: attribs['href'] } : {}),
					rel: 'noopener noreferrer',
					target: '_blank',
				},
			}),
			img: (tagName, attribs) => {
				const transformed: Record<string, string> = {
					alt: attribs['alt'] ?? '',
					src: '',
					'data-src': attribs['src'] ?? '',
				};
				if (attribs['width']) transformed['width'] = attribs['width'];
				if (attribs['height']) transformed['height'] = attribs['height'];
				return { tagName, attribs: transformed };
			},
		},
	});
}
