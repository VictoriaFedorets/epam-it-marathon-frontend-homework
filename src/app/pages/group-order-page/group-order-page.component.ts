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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { forkJoin, map, switchMap } from 'rxjs';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
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

  readonly invite = signal<GuestInvite | null>(null);
  readonly sessions = signal<GroupSessionsResponse | null>(null);
  readonly ownerSessionId = signal<string | null>(null);
  readonly groupStatus = signal<GroupStatusResponse | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly isSubmitting = signal(false);
  readonly isSubmitDialogOpen = signal(false);

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
        },
        error: (error: unknown) => this.handleLoadError(error),
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
}
