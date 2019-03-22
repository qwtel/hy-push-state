/** 
 * Copyright (c) 2019 Florian Klampfer <https://qwtel.com/>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 * 
 * @license 
 * @nocompile
 */
import { Component, Prop, Element, Watch, Method, Event, EventEmitter } from '@stencil/core';

import { Observable, Subject, BehaviorSubject, merge, NEVER, defer, fromEvent } from "rxjs";
import { map, filter, tap, takeUntil, startWith, pairwise, share, mapTo, switchMap, distinctUntilChanged, withLatestFrom, catchError } from 'rxjs/operators';

import { applyMixins, unsubscribeWhen, Context, Cause, ClickContext, isPushEvent, isHashChange, isHintEvent } from './common';

import { FetchManager, ResponseContext } from './fetch';
import { UpdateManager } from './update';
import { EventListenersMixin } from './event-listeners';
import { EventManager } from './event';
import { HistoryManager } from './history';
import { ScrollManager } from './scroll';

@Component({
  tag: 'hy-push-state',
})
export class HyPushState implements Location, EventListenersMixin {
  @Element() el: HTMLElement;

  @Prop({ mutable: true, reflectToAttr: true }) replaceSelector?: string;
  @Prop({ mutable: true, reflectToAttr: true }) linkSelector: string = "a[href]:not([data-no-push])";
  @Prop({ mutable: true, reflectToAttr: true }) scriptSelector?: string;
  @Prop({ mutable: true, reflectToAttr: true }) prefetch: boolean = false;
  @Prop({ mutable: true, reflectToAttr: true }) duration: number = 0;

  @Prop({ mutable: true }) initialHref: string = window.location.href;

  linkSelector$: Subject<string>;
  prefetch$: Subject<boolean>;

  @Watch('linkSelector') setLinkSelector(_: string) { this.linkSelector$.next(_); }
  @Watch('prefetch') setPrefetch(_: boolean) { this.prefetch$.next(_); }

  @Event() start: EventEmitter;
  @Event() ready: EventEmitter;
  @Event() after: EventEmitter;
  @Event() progress: EventEmitter;
  @Event() load: EventEmitter;
  @Event() error: EventEmitter;
  @Event() networkerror: EventEmitter;

  // Location
  private url: URL;
  get hash() { return this.url.hash; }
  get host() { return this.url.host; }
  get hostname() { return this.url.hostname; }
  get href() { return this.url.href; }
  get origin() { return this.url.origin; }
  get pathname() { return this.url.pathname; }
  get port() { return this.url.port; }
  get protocol() { return this.url.protocol; }
  get search() { return this.url.search; }
  get ancestorOrigins() { return window.location.ancestorOrigins; };

  animPromise: Promise<{}>;

  scrollManager = new ScrollManager(this);
  historyManager = new HistoryManager(this);
  fetchManager = new FetchManager(this);
  updateManager = new UpdateManager(this);
  eventManager = new EventManager(this);

  // EventListenersMixin
  setupEventListeners: () => void;
  pushSubject = new Subject<[MouseEvent, HTMLAnchorElement]>();
  hintSubject = new Subject<[Event, HTMLAnchorElement]>();

  reload$ = new Subject<Context>();

  // Methods
  private cacheNr = 0;

  histId() { return this.el.id || this.el.tagName; }

  @Method()
  assign(url: string) {
    this.reload$.next({
      cause: Cause.Push,
      url: new URL(url, this.href),
      cacheNr: ++this.cacheNr,
    });
  }

  @Method()
  reload() {
    this.reload$.next({
      cause: Cause.Push,
      url: new URL(this.href),
      cacheNr: ++this.cacheNr,
      replace: true,
    });
  }

  @Method()
  replace(url: string) {
    this.reload$.next({
      cause: Cause.Push,
      url: new URL(url, this.href),
      cacheNr: ++this.cacheNr,
      replace: true,
    });
  }

  compareContext(p: Context, q: Context) {
    return p.url.href === q.url.href && p.error === q.error && p.cacheNr === q.cacheNr;
  }

  componentWillLoad() {
    this.linkSelector$ = new BehaviorSubject(this.linkSelector);
    this.prefetch$ = new BehaviorSubject(this.prefetch);

    const deferred: { response$?: Observable<ResponseContext> } = {};

    const push$: Observable<ClickContext> = this.pushSubject.pipe(
      // takeUntil(this.subjects.disconnect),
      map(([event, anchor]) => ({
        cause: Cause.Push,
        url: new URL(anchor.href, this.href),
        anchor,
        event,
        cacheNr: this.cacheNr,
      })),
      filter(x => isPushEvent(x, this)),
      tap(({ event }) => {
        event.preventDefault();
        this.historyManager.updateHistoryScrollPosition();
      })
    );

    const pop$: Observable<Context> = fromEvent(window, "popstate").pipe(
      // takeUntil(this.subjects.disconnect),
      filter(() => window.history.state && window.history.state[this.histId()]),
      map(event => ({
        cause: Cause.Pop,
        url: new URL(window.location.href, this.href),
        event,
        cacheNr: this.cacheNr,
      }))
    );

    const reload$ = this.reload$;
    // .pipe(takeUntil(this.subjects.disconnect));

    const merged$ = merge<Context>(push$, pop$, reload$).pipe(
      // HACK: startwith???
      startWith({ url: new URL(this.initialHref) } as Context),
      tap(({ url }) => (this.url = url)),
      pairwise(),
      share(),
    );

    const page$ = merged$.pipe(
      filter(p => !isHashChange(...p)),
      map(([, x]) => x),
      share(),
    );

    const hash$ = merged$.pipe(
      filter(p => isHashChange(...p)),
      map(([, x]) => x),
    );

    const pauser$ = defer(() => merge(
      page$.pipe(mapTo(true)),
      deferred.response$.pipe(mapTo(false)),
    )).pipe(
      startWith(false),
      // share(),
    );

    const hint$: Observable<Context> = this.prefetch$.pipe(switchMap(prefetch => {
      if (!prefetch) return NEVER;

      return this.hintSubject.pipe(
        // tap(x => console.log(x)),
        // takeUntil(this.subjects.disconnect),
        unsubscribeWhen(pauser$),
        map(([event, anchor]) => ({
          cause: Cause.Hint,
          url: new URL(anchor.href, this.href),
          anchor,
          event,
          cacheNr: this.cacheNr,
        })),
        filter(x => isHintEvent(x, this)),
      );
    }));

    const prefetchResponse$ = merge(hint$, page$).pipe(
      distinctUntilChanged((x, y) => this.compareContext(x, y)),
      switchMap(x => this.fetchManager.fetchPage(x)),
      startWith({ url: {} } as ResponseContext),
      share(),
    );

    const response$ = deferred.response$ = page$.pipe(
      tap(context => {
        this.historyManager.updateHistoryState(context);
        this.eventManager.onStart(context);
      }),
      withLatestFrom(prefetchResponse$),
      switchMap((args) => this.fetchManager.getResponse(prefetchResponse$, ...args)), 
      share(),
    );

    const responseOk$ = response$.pipe(filter(({ error }) => !error));
    const responseErr$ = response$.pipe(filter(({ error }) => error));

    const main$ = responseOk$.pipe(
      map(context => this.updateManager.responseToContent(context)),
      tap(context => {
        this.eventManager.emitReady(context);
        this.updateManager.updateDOM(context);
        this.historyManager.updateHistoryTitle(context);
        this.scrollManager.manageScrollPostion(context);
        this.eventManager.emitAfter(context);
      }),
      tap({ error: e => this.eventManager.emitDOMError(e) }),
      catchError((_, c) => c),
      switchMap(x => this.updateManager.reinsertScriptTags(x)),
      tap({ error: e => this.eventManager.emitError(e) }),
      catchError((_, c) => c)
    );

    main$.subscribe(context => this.eventManager.emitLoad(context));

    hash$.subscribe(context => {
      this.historyManager.updateHistoryStateHash(context);
      this.scrollManager.manageScrollPostion(context);
    });

    responseErr$.subscribe(e => this.eventManager.emitNetworkError(e));

    page$.pipe(switchMap(context =>
      defer(() => this.animPromise).pipe(
        takeUntil(response$),
        mapTo(context),
      ),
    )).subscribe(context => this.eventManager.emitProgress(context));

    this.setupEventListeners();
  }
}

applyMixins(HyPushState, [EventListenersMixin]);