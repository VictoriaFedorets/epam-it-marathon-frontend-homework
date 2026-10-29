import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ToastService } from '../services/toast/toast.service';
import { AuthenticationService } from './services/authentication.service';
import { SKIP_ERROR_TOAST } from './skip-error-toast.context';
import { tokenInterceptor } from './token.interceptor';

const URL = 'https://test.api/reservations';

describe('tokenInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let toastService: jasmine.SpyObj<ToastService>;
  let authService: jasmine.SpyObj<AuthenticationService>;

  beforeEach(() => {
    toastService = jasmine.createSpyObj<ToastService>('ToastService', ['error']);
    authService = jasmine.createSpyObj<AuthenticationService>('AuthenticationService', [
      'getTokens',
    ]);
    authService.getTokens.and.returnValue(null);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([tokenInterceptor])),
        provideHttpClientTesting(),
        { provide: ToastService, useValue: toastService },
        { provide: AuthenticationService, useValue: authService },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('shows the server message in a toast for a 400 response', () => {
    http.post(URL, {}).subscribe({ error: () => undefined });

    httpMock
      .expectOne(URL)
      .flush({ message: 'Overlaps' }, { status: 400, statusText: 'Bad Request' });

    expect(toastService.error).toHaveBeenCalledWith('Overlaps', 'Error');
  });

  it('does not show a toast but still rethrows when SKIP_ERROR_TOAST is set', () => {
    let receivedStatus: number | undefined;
    http
      .post(URL, {}, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) })
      .subscribe({ error: (error) => (receivedStatus = error.status) });

    httpMock
      .expectOne(URL)
      .flush({ message: 'Overlaps' }, { status: 400, statusText: 'Bad Request' });

    expect(toastService.error).not.toHaveBeenCalled();
    expect(receivedStatus).toBe(400);
  });

  it('does not show a toast for silent guest requests', () => {
    let receivedStatus: number | undefined;
    const guestUrl = 'https://test.api/guest/groups/grp-1/sessions';
    http
      .get(guestUrl, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) })
      .subscribe({ error: (error) => (receivedStatus = error.status) });

    httpMock
      .expectOne(guestUrl)
      .flush({ message: 'Unavailable' }, { status: 500, statusText: 'Server Error' });

    expect(toastService.error).not.toHaveBeenCalled();
    expect(receivedStatus).toBe(500);
  });

  it('adds the Cognito idToken to owner group session requests only', () => {
    authService.getTokens.and.returnValue({
      idToken: 'customer-id-token',
      accessToken: 'customer-access-token',
    });

    const ownerSessionsUrl = 'https://test.api/develop/guest/groups/grp-1/sessions';
    http.get(ownerSessionsUrl).subscribe();
    const getSessionsRequest = httpMock.expectOne(ownerSessionsUrl);
    expect(getSessionsRequest.request.headers.get('Authorization')).toBe(
      'Bearer customer-id-token'
    );
    getSessionsRequest.flush({ participants: [], total: 0 });

    const removeGuestUrl = `${ownerSessionsUrl}/guest-1`;
    http.delete(removeGuestUrl).subscribe();
    const removeGuestRequest = httpMock.expectOne(removeGuestUrl);
    expect(removeGuestRequest.request.headers.get('Authorization')).toBe(
      'Bearer customer-id-token'
    );
    removeGuestRequest.flush({ participants: [], total: 0 });

    const publicStatusUrl = 'https://test.api/develop/guest/groups/grp-1/status';
    http.get(publicStatusUrl).subscribe();
    const statusRequest = httpMock.expectOne(publicStatusUrl);
    expect(statusRequest.request.headers.has('Authorization')).toBeFalse();
    statusRequest.flush({ currentParticipants: 1, maxCapacity: 5, status: 'Open' });

    const guestCartUrl = 'https://test.api/develop/guest/sessions/guest-1';
    http.get(guestCartUrl).subscribe();
    const guestCartRequest = httpMock.expectOne(guestCartUrl);
    expect(guestCartRequest.request.headers.has('Authorization')).toBeFalse();
    guestCartRequest.flush({});
  });
});
