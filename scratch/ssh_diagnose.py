import paramiko
import sys
import re

def run_ssh_command(ssh, cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='ignore').strip()
    err = stderr.read().decode('utf-8', errors='ignore').strip()
    return out, err

def main():
    hostname = "172.16.1.54"
    username = "root"
    password = "gericom"
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(hostname, username=username, password=password, timeout=10)
        print(f"Connected to Proxmox host: {hostname}")
    except Exception as e:
        print(f"Failed to connect to {hostname}: {e}")
        sys.exit(1)
        
    print("=== Listing LXC Containers ===")
    pct_list, _ = run_ssh_command(ssh, "pct list")
    print(pct_list)
    print("=" * 40)
    
    # Find all containers related to unifi-health-check
    for line in pct_list.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 4:
            vmid = parts[0]
            status = parts[1]
            name = parts[3]
            
            if "unifi-health-check" in name:
                print(f"Diagnosing container {vmid} ({name}) - Status: {status}")
                if status == "running":
                    ip_out, _ = run_ssh_command(ssh, f"pct exec {vmid} -- hostname -I")
                    print(f"  Container IP(s): {ip_out}")
                    
                    docker_check, _ = run_ssh_command(ssh, f"pct exec {vmid} -- which docker")
                    print(f"  Docker path: {docker_check}")
                    
                    if docker_check:
                        ps_out, _ = run_ssh_command(ssh, f"pct exec {vmid} -- docker ps -a")
                        print("  Docker containers:")
                        print(ps_out)
                        
                        ss_out, _ = run_ssh_command(ssh, f"pct exec {vmid} -- ss -tulpn")
                        print("  Listening ports inside container:")
                        print(ss_out)
                        
                        logs_out, _ = run_ssh_command(ssh, f"pct exec {vmid} -- docker compose -f /opt/unifi-health-check/docker-compose.yml logs --tail=20")
                        print("  Docker compose logs:")
                        print(logs_out)
                    else:
                        print("  Docker is NOT installed in this container.")
                else:
                    print("  Container is stopped.")
                print("=" * 40)
                
    ssh.close()

if __name__ == "__main__":
    main()
