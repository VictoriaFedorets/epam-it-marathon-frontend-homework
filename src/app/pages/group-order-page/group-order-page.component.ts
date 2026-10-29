import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import {
  EMPTY,
  Subscription,
  catchError,
  exhaustMap,
  forkJoin,
  interval,
  map,
  merge,
  skip,
  switchMap,
  tap,
} from 'rxjs';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { Participant } from '@app/models/group-orders/participant.model';
import { GroupSessionsResponse } from '@app/models/group-orders/group-sessions-response.model';
import {
  GroupReservationStatus,
  GroupStatusResponse,
} from '@app/models/group-orders/group-status.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';

const SYNC_INTERVAL_MS = 15_000;

@Component({
  selector: 'app-group-order-page',
  imports: [CurrencyPipe, DatePipe, ModalComponent, ParticipantCardComponent],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly groupOrdersService = inject(GroupOrdersService);
  private readonly toastService = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reservationId = this.route.snapshot.paramMap.get('reservationId');
  private readonly refreshRequests = signal(0);
  private readonly refreshRequests$ = toObservable(this.refreshRequests).pipe(skip(1));
  private pollingSubscription: Subscription | null = null;

  readonly invite = signal<GuestInvite | null>(null);
  readonly sessions = signal<GroupSessionsResponse | null>(null);
  readonly ownerSessionId = signal<string | null>(null);
  readonly groupStatus = signal<GroupStatusResponse | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly isSubmitting = signal(false);
  readonly isSubmitDialogOpen = signal(false);
  readonly selectedGuest = signal<Participant | null>(null);
  readonly isRemovingGuest = signal(false);
  readonly lastUpdatedAt = signal<Date | null>(null);
  readonly refreshFailed = signal(false);

  readonly participants = computed(() => this.sessions()?.participants ?? []);
  readonly consolidatedOrder = computed(() => consolidatePreOrder(this.participants()));
  readonly pendingCount = computed(
    () => this.participants().filter((participant) => !participant.isSubmitted).length
  );
  readonly hasPendingParticipants = computed(() => this.pendingCount() > 0);
  readonly hasDishes = computed(() =>
    this.participants().some((participant) => participant.items.length > 0)
  );
  readonly isSubmitted = computed(() => this.groupStatus()?.status === 'Submitted');
  readonly isReadOnly = computed(() => this.groupStatus()?.status !== 'Open');
  readonly visibleParticipants = computed(() =>
    this.isSubmitted()
      ? this.participants().filter((participant) => participant.isSubmitted)
      : this.participants()
  );
  readonly statusLabel = computed(() => this.getStatusLabel(this.groupStatus()?.status));
  readonly canSubmit = computed(
    () =>
      this.groupStatus()?.status === 'Open' &&
      this.consolidatedOrder().items.length > 0 &&
      !this.isSubmitting()
  );

  constructor() {
    this.loadData();
  }

  loadData(): void {
    this.stopPolling();
    const reservationId = this.reservationId;
    if (!reservationId) {
      this.loading.set(false);
      this.loadError.set('Group reservation not found');
      return;
    }

    this.loading.set(true);
    this.loadError.set(null);

    this.groupOrdersService
      .getGroupInvite$(reservationId)
      .pipe(
        switchMap((invite) =>
          forkJoin({
            sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId),
            ownerSessionId: this.groupOrdersService.getOwnerSessionId$(reservationId),
            status: this.groupOrdersService.getStatus$(invite.GroupReservationId),
          }).pipe(map((data) => ({ invite, ...data })))
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: ({ invite, sessions, ownerSessionId, status }) => {
          this.invite.set(invite);
          this.sessions.set(sessions);
          this.ownerSessionId.set(ownerSessionId);
          this.groupStatus.set(status);
          this.loading.set(false);
          this.lastUpdatedAt.set(new Date());
          this.refreshFailed.set(false);
          if (status.status === 'Open') {
            this.startPolling(invite.GroupReservationId);
          } else {
            this.stopPolling();
          }
        },
        error: (error: unknown) => this.handleLoadError(error),
      });
  }

  refreshNow(): void {
    if (!this.isSubmitted() && this.groupStatus()?.status === 'Open') {
      this.refreshRequests.update((count) => count + 1);
    }
  }

  openRemoveDialog(participant: Participant): void {
    if (participant.type === 'Guest' && this.groupStatus()?.status === 'Open') {
      this.selectedGuest.set(participant);
    }
  }

  closeRemoveDialog(): void {
    if (!this.isRemovingGuest()) {
      this.selectedGuest.set(null);
    }
  }

  confirmRemoveGuest(): void {
    const invite = this.invite();
    const guest = this.selectedGuest();
    if (
      !invite ||
      !guest ||
      guest.type !== 'Guest' ||
      this.groupStatus()?.status !== 'Open' ||
      this.isRemovingGuest()
    ) {
      return;
    }

    this.isRemovingGuest.set(true);
    this.groupOrdersService
      .removeSession$(invite.GroupReservationId, guest.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (snapshot) => {
          this.sessions.set(snapshot);
          this.selectedGuest.set(null);
          this.isRemovingGuest.set(false);
          this.toastService.success('Guest removed from the reservation');
        },
        error: () => this.isRemovingGuest.set(false),
      });
  }

  openSubmitDialog(): void {
    if (this.canSubmit()) {
      this.isSubmitDialogOpen.set(true);
    }
  }

  closeSubmitDialog(): void {
    if (!this.isSubmitting()) {
      this.isSubmitDialogOpen.set(false);
    }
  }

  confirmSubmit(): void {
    const invite = this.invite();
    if (!invite || !this.reservationId || !this.canSubmit()) {
      return;
    }

    this.isSubmitting.set(true);
    this.groupOrdersService
      .submit$(invite.GroupReservationId, this.reservationId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          const currentStatus = this.groupStatus();
          if (currentStatus) {
            this.groupStatus.set({ ...currentStatus, status: 'Submitted' });
          }
          this.stopPolling();
          this.isSubmitting.set(false);
          this.isSubmitDialogOpen.set(false);
          this.toastService.success('Pre-order sent to the restaurant');
        },
        error: () => {
          this.isSubmitting.set(false);
          this.isSubmitDialogOpen.set(false);
        },
      });
  }

  getStatusLabel(status: GroupReservationStatus | undefined): string {
    switch (status) {
      case 'Open':
        return 'Collecting pre-orders';
      case 'Submitted':
        return 'Sent to Restaurant';
      case 'Closed':
        return 'Closed';
      default:
        return '';
    }
  }

  private handleLoadError(error: unknown): void {
    this.loading.set(false);
    this.loadError.set(
      error instanceof HttpErrorResponse && error.status === 404
        ? 'Group reservation not found'
        : 'Unable to load group reservation. Please try again.'
    );
  }

  private startPolling(groupReservationId: string): void {
    if (this.pollingSubscription) {
      return;
    }

    this.pollingSubscription = merge(interval(SYNC_INTERVAL_MS), this.refreshRequests$)
      .pipe(
        exhaustMap(() =>
          forkJoin({
            sessions: this.groupOrdersService.getSessions$(groupReservationId, { silent: true }),
            status: this.groupOrdersService.getStatus$(groupReservationId, { silent: true }),
          }).pipe(
            tap(({ sessions, status }) => {
              this.sessions.set(sessions);
              this.groupStatus.set(status);
              this.lastUpdatedAt.set(new Date());
              this.refreshFailed.set(false);
              if (status.status !== 'Open') {
                this.stopPolling();
              }
            }),
            catchError(() => {
              this.refreshFailed.set(true);
              return EMPTY;
            })
          )
        ),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();
  }

  private stopPolling(): void {
    this.pollingSubscription?.unsubscribe();
    this.pollingSubscription = null;
  }
}
