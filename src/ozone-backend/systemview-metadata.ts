import {
  SystemViewEventId,
  SystemViewExtendedEventId,
  type SystemViewEvent,
} from './systemview-protocol';

export interface SystemViewTaskMetadata {
  readonly taskId: number;
  readonly name?: string;
  readonly priority?: number;
  readonly stackBase?: number;
  readonly stackSize?: number;
  readonly stackUsage?: number;
}

export interface SystemViewModuleMetadata {
  readonly moduleId: number;
  readonly eventOffset: number;
  readonly description: string;
}

export interface SystemViewResourceMetadata {
  readonly resourceId: number;
  readonly name: string;
}

export interface SystemViewMarkerMetadata {
  readonly markerId: number;
  readonly name?: string;
}

export interface SystemViewMetadataDiagnostic {
  readonly code: 'conflicting-task-info' | 'conflicting-resource-name' | 'malformed-description';
  readonly message: string;
  readonly eventTimestamp?: number;
}

export interface SystemViewMetadataSnapshot {
  readonly sysFrequency?: number;
  readonly cpuFrequency?: number;
  readonly ramBase?: number;
  readonly idShift?: number;
  readonly descriptions: readonly string[];
  readonly descriptionFields: Readonly<Record<string, string>>;
  readonly interrupts: Readonly<Record<string, string>>;
  readonly tasks: readonly SystemViewTaskMetadata[];
  readonly modules: readonly SystemViewModuleMetadata[];
  readonly resources: readonly SystemViewResourceMetadata[];
  readonly markers: readonly SystemViewMarkerMetadata[];
  readonly diagnostics: readonly SystemViewMetadataDiagnostic[];
}

interface MutableTaskMetadata {
  taskId: number;
  name?: string;
  priority?: number;
  stackBase?: number;
  stackSize?: number;
  stackUsage?: number;
}

export class SystemViewMetadataStore {
  private sysFrequency?: number;
  private cpuFrequency?: number;
  private ramBase?: number;
  private idShift?: number;
  private readonly descriptions: string[] = [];
  private readonly descriptionFields = new Map<string, string>();
  private readonly interrupts = new Map<number, string>();
  private readonly tasks = new Map<number, MutableTaskMetadata>();
  private readonly modules = new Map<number, SystemViewModuleMetadata>();
  private readonly resources = new Map<number, SystemViewResourceMetadata>();
  private readonly markers = new Map<number, SystemViewMarkerMetadata>();
  private readonly diagnostics: SystemViewMetadataDiagnostic[] = [];

  public apply(event: SystemViewEvent): void {
    const payload = event.payload;
    switch (payload.kind) {
      case 'init':
        this.sysFrequency = payload.sysFrequency;
        this.cpuFrequency = payload.cpuFrequency;
        this.ramBase = payload.ramBase;
        this.idShift = payload.idShift;
        return;
      case 'system-description':
        this.applyDescription(payload.text, event.timestamp);
        return;
      case 'task-info':
        this.applyTaskInfo(payload.taskId, payload.name, payload.priority, event.timestamp);
        return;
      case 'stack-info':
        this.applyStackInfo(payload.taskId, payload.stackBase, payload.stackSize, payload.stackUsage);
        return;
      case 'module-description':
        this.modules.set(payload.moduleId, {
          moduleId: payload.moduleId,
          eventOffset: payload.eventOffset,
          description: payload.description,
        });
        return;
      case 'resource-name':
        this.applyResource(payload.resourceId, payload.name, event.timestamp);
        return;
      case 'extended':
        if (payload.extendedEventId === SystemViewExtendedEventId.NAME_MARKER && payload.values.length >= 1) {
          this.markers.set(payload.values[0], {
            markerId: payload.values[0],
            name: payload.strings[0],
          });
        } else if (payload.extendedEventId === SystemViewExtendedEventId.MARK && payload.values.length >= 1) {
          if (!this.markers.has(payload.values[0])) {
            this.markers.set(payload.values[0], { markerId: payload.values[0] });
          }
        }
        return;
      default:
        return;
    }
  }

  public snapshot(): SystemViewMetadataSnapshot {
    const descriptionFields: Record<string, string> = {};
    for (const [key, value] of this.descriptionFields) descriptionFields[key] = value;
    const interrupts: Record<string, string> = {};
    for (const [id, name] of this.interrupts) interrupts[String(id)] = name;
    return {
      ...(this.sysFrequency === undefined ? {} : { sysFrequency: this.sysFrequency }),
      ...(this.cpuFrequency === undefined ? {} : { cpuFrequency: this.cpuFrequency }),
      ...(this.ramBase === undefined ? {} : { ramBase: this.ramBase }),
      ...(this.idShift === undefined ? {} : { idShift: this.idShift }),
      descriptions: [...this.descriptions],
      descriptionFields,
      interrupts,
      tasks: [...this.tasks.values()]
        .sort((left, right) => left.taskId - right.taskId)
        .map(task => ({ ...task })),
      modules: [...this.modules.values()].sort((left, right) => left.moduleId - right.moduleId),
      resources: [...this.resources.values()].sort((left, right) => left.resourceId - right.resourceId),
      markers: [...this.markers.values()].sort((left, right) => left.markerId - right.markerId),
      diagnostics: [...this.diagnostics],
    };
  }

  public reset(): void {
    this.sysFrequency = undefined;
    this.cpuFrequency = undefined;
    this.ramBase = undefined;
    this.idShift = undefined;
    this.descriptions.length = 0;
    this.descriptionFields.clear();
    this.interrupts.clear();
    this.tasks.clear();
    this.modules.clear();
    this.resources.clear();
    this.markers.clear();
    this.diagnostics.length = 0;
  }

  private applyDescription(text: string, timestamp: number): void {
    this.descriptions.push(text);
    for (const item of text.split(',')) {
      const separator = item.indexOf('=');
      if (separator <= 0) {
        if (item.length > 0) {
          this.diagnostics.push({
            code: 'malformed-description',
            message: `SystemView description item has no key/value separator: ${item}`,
            eventTimestamp: timestamp,
          });
        }
        continue;
      }
      const key = item.slice(0, separator).trim();
      const value = item.slice(separator + 1);
      this.descriptionFields.set(key, value);
      const interrupt = /^I#(\d+)$/.exec(key);
      if (interrupt) this.interrupts.set(Number(interrupt[1]), value);
    }
  }

  private applyTaskInfo(taskId: number, name: string, priority: number, timestamp: number): void {
    const task = this.tasks.get(taskId) ?? { taskId };
    if (task.name !== undefined && task.name !== name) {
      this.diagnostics.push({
        code: 'conflicting-task-info',
        message: `Task ${taskId} changed name from ${task.name} to ${name}`,
        eventTimestamp: timestamp,
      });
    }
    task.name = name;
    task.priority = priority;
    this.tasks.set(taskId, task);
  }

  private applyStackInfo(taskId: number, stackBase: number, stackSize: number, stackUsage: number): void {
    const task = this.tasks.get(taskId) ?? { taskId };
    task.stackBase = stackBase;
    task.stackSize = stackSize;
    task.stackUsage = stackUsage;
    this.tasks.set(taskId, task);
  }

  private applyResource(resourceId: number, name: string, timestamp: number): void {
    const previous = this.resources.get(resourceId);
    if (previous && previous.name !== name) {
      this.diagnostics.push({
        code: 'conflicting-resource-name',
        message: `Resource ${resourceId} changed name from ${previous.name} to ${name}`,
        eventTimestamp: timestamp,
      });
    }
    this.resources.set(resourceId, { resourceId, name });
  }
}

export function parseSystemViewDescription(text: string): {
  readonly fields: Readonly<Record<string, string>>;
  readonly interrupts: Readonly<Record<string, string>>;
} {
  const fields: Record<string, string> = {};
  const interrupts: Record<string, string> = {};
  for (const item of text.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) continue;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1);
    fields[key] = value;
    const interrupt = /^I#(\d+)$/.exec(key);
    if (interrupt) interrupts[interrupt[1]] = value;
  }
  return { fields, interrupts };
}

export function isSystemViewMetadataEvent(event: SystemViewEvent): boolean {
  return event.eventId === SystemViewEventId.INIT
    || event.eventId === SystemViewEventId.SYSDESC
    || event.eventId === SystemViewEventId.TASK_INFO
    || event.eventId === SystemViewEventId.STACK_INFO
    || event.eventId === SystemViewEventId.MODULEDESC
    || event.eventId === SystemViewEventId.NAME_RESOURCE
    || event.eventId === SystemViewEventId.EX;
}
