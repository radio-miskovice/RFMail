import type { PttInput } from '@rfmail/shared';

/** The connector names an operator uses, not Hamlib's constants (R2.2.1). */
export const PTT_INPUT_LABELS: Record<PttInput, string> = {
	rear: 'Rear input',
	front: 'Front microphone',
	auto: 'Rear, with fallback'
};
