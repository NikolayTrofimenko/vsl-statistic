import { handle } from './rpc';
import { currentUser } from '../users';
import { deleteOffer, listOffers, saveOffer } from '../offers';
import type { Offer, OfferInput } from '../../src/shared/api.types';

/** `offers:list` needs section offers; save/delete need offersEdit (`server/http/app.ts`). */
export function registerOffersHandlers(): void {
  handle('offers:list', (): Offer[] => listOffers());
  handle('offers:save', (input: OfferInput): Offer => saveOffer(input ?? ({} as OfferInput), currentUser().id));
  handle('offers:delete', (id: number): void => deleteOffer(Number(id)));
}
