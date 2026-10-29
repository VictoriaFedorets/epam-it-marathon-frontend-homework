import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { Observable, map, switchMap, tap } from 'rxjs';
import { SKIP_ERROR_TOAST } from '@app/auth/skip-error-toast.context';
import { OwnerSessionResponse } from '@app/models/group-orders/owner-session.model';
import { GroupSessionsResponse } from '@app/models/group-orders/group-sessions-response.model';
import { GroupStatusResponse } from '@app/models/group-orders/group-status.model';
import {
  SubmittedDish,
  SubmitGroupPreOrderRequest,
} from '@app/models/group-orders/submit-group-pre-order.model';
import { GuestInviteService } from '@app/services/reservation/guest-invite.service';
import { API_BASE_URL } from '@app/shared/config/api-base-url.token';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';

export interface GroupOrderRequestOptions {
  silent?: boolean;
}

@Injectable({ providedIn: 'root' })
export class GroupOrdersService {
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly http = inject(HttpClient);
  private readonly guestInviteService = inject(GuestInviteService);

  readonly ownerSessionCredentials = signal<OwnerSessionResponse | null>(null);

  getGroupInvite$(reservationId: string): Observable<GuestInvite> {
    return this.guestInviteService
      .getInviteToken$(reservationId)
      .pipe(switchMap(({ token }) => this.guestInviteService.getInvite$(token)));
  }

  getSessions$(
    groupReservationId: string,
    options: GroupOrderRequestOptions = {}
  ): Observable<GroupSessionsResponse> {
    return this.http.get<GroupSessionsResponse>(
      `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/sessions`,
      { context: this.requestContext(options) }
    );
  }

  getOwnerSessionId$(reservationId: string): Observable<string> {
    return this.http
      .get<OwnerSessionResponse>(
        `${this.baseUrl}/reservations/${encodeURIComponent(reservationId)}/guest-session-id`
      )
      .pipe(
        tap((credentials) => this.ownerSessionCredentials.set(credentials)),
        map(({ guestSessionId }) => guestSessionId)
      );
  }

  getStatus$(
    groupReservationId: string,
    options: GroupOrderRequestOptions = {}
  ): Observable<GroupStatusResponse> {
    return this.http.get<GroupStatusResponse>(
      `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/status`,
      { context: this.requestContext(options) }
    );
  }

  removeSession$(
    groupReservationId: string,
    guestSessionId: string
  ): Observable<GroupSessionsResponse> {
    return this.http.delete<GroupSessionsResponse>(
      `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/sessions/${encodeURIComponent(guestSessionId)}`
    );
  }

  submit$(groupReservationId: string, reservationId: string): Observable<SubmittedDish[]> {
    const body: SubmitGroupPreOrderRequest = { reservationId };
    return this.http.post<SubmittedDish[]>(
      `${this.baseUrl}/group-reservations/${encodeURIComponent(groupReservationId)}/submit`,
      body
    );
  }

  private requestContext(options: GroupOrderRequestOptions): HttpContext {
    return new HttpContext().set(SKIP_ERROR_TOAST, options.silent ?? false);
  }
}
