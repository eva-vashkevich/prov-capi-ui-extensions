import { IClusterProvisioner, ClusterProvisionerContext } from '@shell/core/types';
import { mapDriver } from '@shell/store/plugins';
import { DEFAULT_WORKSPACE } from '@shell/config/types';
import { initInfrastructureCluster, saveMachinePoolConfigs, saveInfrastructureCluster, updateProvCluster } from './utils';
import { AWS_CLUSTER_SCHEMA, AWS_MACHINE_TEMPLATE_SCHEMA } from './types/capa';
import ClusterConfiguration from './components/ClusterConfiguration.vue';
import { isProviderEnabled } from "@shell/utils/settings";

export class CAPAProvisioner implements IClusterProvisioner {
  static ID = 'awsmachinetemplate';

  constructor(private context: ClusterProvisionerContext) {
    mapDriver(this.id, 'aws' );
  }

  get id(): string {
    console.log(CAPAProvisioner.ID)
    return CAPAProvisioner.ID;
  }

  get machineConfigSchema(): { [key: string]: any } {
    return this.context.getters['management/schemaFor'](AWS_MACHINE_TEMPLATE_SCHEMA, true, false);
  }

  get clusterSchema(): { [key: string]: any } {
    return this.context.getters['management/schemaFor'](AWS_CLUSTER_SCHEMA, true, false);
  }

  get createMachinePoolMachineConfig(): () => Promise<{[key: string]: any}> {
    return async() => {
      const machineConfigType = this.machineConfigSchema?.id || AWS_MACHINE_TEMPLATE_SCHEMA;

      await this.context.dispatch('management/waitForSchema', { type: machineConfigType });

      const createConfig = await this.context.dispatch('management/createPopulated', {
        type:     AWS_MACHINE_TEMPLATE_SCHEMA,
        metadata: { namespace: DEFAULT_WORKSPACE }
      });

      const config = createConfig || {};

      // TODO apply some defaults maybe?
      return config;
    };
  }

  get saveMachinePoolConfigs(): (pools: any[], cluster: any) => Promise<any> {
    return async(pools: any[], cluster: any) => await saveMachinePoolConfigs(pools, cluster, this.context.dispatch);
  }

  get saveInfrastructureCluster(): (value: any, infrastructureCluster: any, isEdit: boolean) => Promise<void> {
    return async(value, infrastructureCluster, isEdit) => await saveInfrastructureCluster(value, infrastructureCluster, isEdit);
  }

  get initInfrastructureCluster(): (value: any, infrastructureCluster: any, isEdit: boolean) => Promise<void> {
    const clusterSchemaType = this.clusterSchema?.id || this.clusterSchema;

    return async(value, isEdit) => await initInfrastructureCluster(value, clusterSchemaType, this.context, isEdit);
  }

  get icon(): any {
    return require('./assets/amazonecapa.svg');
  }

  get group(): string {
    return 'capi';
  }

  get label(): string {
    return this.context.t('capa.label');
  }

  get description(): string {
    return this.context.t('capa.description');
  }

  get hidden(): boolean {
    return ! isProviderEnabled(this.context, 'aws');
  }

  get extensionInfrastructureSection(): any {
    return ClusterConfiguration;
  }

  get detailTabs(): any {
    return {
      machines:     false,
      logs:         false,
      registration: false,
      snapshots:    false,
      related:      true,
      events:       false,
      conditions:   false,
    };
  }

  get showImport(): boolean {
    return false;
  }

  get isUpstreamCAPIProvider(): boolean {
    return true;
  }

  registerSaveHooks(
    registerBeforeHook: (fn: () => Promise<void>, name: string, priority?: number) => void,
    _registerAfterHook: any,
    value: any,
  ): void {
    registerBeforeHook(() => updateProvCluster(value), 'update-prov-cluster-for-capi', 4);
  }
}
