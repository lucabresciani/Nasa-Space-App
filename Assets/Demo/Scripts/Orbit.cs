using UnityEngine;

public class Orbit : MonoBehaviour
{
    public Transform target;
    public float orbitSpeed = 20f; // degrees per second around target
    public float spinSpeed = 50f;  // degrees per second around own Y axis

    void Update()
    {
        if (target != null)
        {
            transform.RotateAround(target.position, Vector3.up, orbitSpeed * Time.deltaTime);
        }

        transform.Rotate(0f, spinSpeed * Time.deltaTime, 0f, Space.Self);
    }
}
